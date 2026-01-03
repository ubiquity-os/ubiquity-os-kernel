import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import type { GitHubContext } from "../src/github/github-context.ts";
import { type ConversationNode, listConversationNodesForKey, resolveConversationKeyForContext } from "../src/github/utils/conversation-graph.ts";
import { buildConversationContext } from "../src/github/utils/conversation-context.ts";

type Options = Readonly<{
  showContext: boolean;
  includeSemantic: boolean;
  maxNodes: number;
  isVerbose: boolean;
  colorMode: "auto" | "always" | "never";
  showNotes: boolean;
}>;

type ParsedUrl = Readonly<{
  owner: string;
  repo: string;
  number: number;
  kind: "issue" | "pull";
}>;

const DEFAULT_MAX_NODES = 40;
const TITLE_MAX_CHARS = 120;
const USAGE = `
Render an ASCII conversation graph from a GitHub issue/PR URL.

Usage:
  deno run -A --sloppy-imports scripts/conversation-graph.ts <github-url> [options]

Options:
  --no-context      Hide conversationContext summary
  --no-semantic     Hide semantic threads (context still shown)
  --max-nodes=N     Limit number of KV nodes shown (default: ${DEFAULT_MAX_NODES})
  --verbose         Print debug warnings from graph resolution
  --color           Force ANSI color output
  --no-color        Disable ANSI color output
  --no-notes        Hide the "Notes" section
  --context         (default) Include conversationContext summary
  --semantic        (default) Include semantic threads in the context
  -h, --help        Show this help
`.trim();

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function formatNode(node: ConversationNode): string {
  const typeLabel = node.type === "Issue" ? "Issue" : "PR";
  const repoLabel = node.owner && node.repo ? `${node.owner}/${node.repo}` : "unknown/unknown";
  const numberLabel = typeof node.number === "number" ? `#${node.number}` : "";
  const title = node.title ? ` - ${truncate(node.title, TITLE_MAX_CHARS)}` : "";
  return `[${typeLabel}] ${repoLabel}${numberLabel}${title}`;
}

function supportsColor(): boolean {
  const forceColor = Deno.env.get("FORCE_COLOR");
  const noColor = Deno.env.get("NO_COLOR");
  const term = (Deno.env.get("TERM") ?? "").toLowerCase();
  return (forceColor !== undefined && forceColor !== "0") || (noColor === undefined && term !== "" && term !== "dumb");
}

function resolveColorMode(mode: Options["colorMode"]): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return supportsColor();
}

function colorize(text: string, code: string, isColorEnabled: boolean): string {
  if (!isColorEnabled) return text;
  return `${code}${text}\u001b[0m`;
}

function renderNodeList(
  title: string,
  nodes: ConversationNode[],
  isColorEnabled: boolean,
  options: Readonly<{ indent?: string; showHeader?: boolean }> = {}
): void {
  const indent = options.indent ?? "";
  const showHeader = options.showHeader !== false;
  if (showHeader) {
    const countLabel = colorize(`[${nodes.length}]`, "\u001b[2m", isColorEnabled);
    console.log(`${indent}${title} ${countLabel}`);
  }
  if (!nodes.length) {
    console.log(`${indent}\`-- ${colorize("(none)", "\u001b[2m", isColorEnabled)}`);
    return;
  }
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const branch = isLast ? "`--" : "|--";
    const childIndent = isLast ? "    " : "|   ";
    const nodeText = formatNode(node);
    console.log(`${indent}${branch} ${colorize(nodeText, "\u001b[36m", isColorEnabled)}`);
    if (node.url) {
      console.log(`${indent}${childIndent}${colorize(node.url, "\u001b[2m", isColorEnabled)}`);
    }
  });
}

function parseArgs(args: string[]): { url: string | null; options: Options } {
  let url: string | null = null;
  let showContext = true;
  let includeSemantic = true;
  let maxNodes = DEFAULT_MAX_NODES;
  let isVerbose = false;
  let colorMode: Options["colorMode"] = "auto";
  let showNotes = true;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      Deno.exit(0);
    }
    if (arg === "--context") {
      showContext = true;
      continue;
    }
    if (arg === "--no-context") {
      showContext = false;
      continue;
    }
    if (arg === "--semantic") {
      includeSemantic = true;
      continue;
    }
    if (arg === "--no-semantic") {
      includeSemantic = false;
      continue;
    }
    if (arg === "--verbose") {
      isVerbose = true;
      continue;
    }
    if (arg === "--color") {
      colorMode = "always";
      continue;
    }
    if (arg === "--no-color") {
      colorMode = "never";
      continue;
    }
    if (arg === "--no-notes") {
      showNotes = false;
      continue;
    }
    if (arg === "--max-nodes" && args[i + 1]) {
      maxNodes = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--max-nodes=")) {
      maxNodes = Number(arg.split("=").slice(1).join("="));
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      console.log(USAGE);
      Deno.exit(1);
    }
    if (!url) {
      url = arg;
    } else {
      console.error(`Unexpected extra argument: ${arg}`);
      console.log(USAGE);
      Deno.exit(1);
    }
  }

  if (!Number.isFinite(maxNodes) || maxNodes <= 0) {
    maxNodes = DEFAULT_MAX_NODES;
  }

  return { url, options: { showContext, includeSemantic, maxNodes, isVerbose, colorMode, showNotes } };
}

function parseGithubUrl(input: string): ParsedUrl {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch (error) {
    throw new Error(`Invalid URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
    throw new Error("Only github.com URLs are supported.");
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 4) {
    throw new Error("Expected URL format: https://github.com/<owner>/<repo>/(issues|pull|pulls)/<number>");
  }
  const owner = parts[0];
  const repo = parts[1];
  const category = parts[2];
  const number = Number(parts[3]);
  if (!owner || !repo || !Number.isFinite(number)) {
    throw new Error("Could not parse owner/repo/number from URL.");
  }
  let kind: ParsedUrl["kind"] | null = null;
  if (category === "pull" || category === "pulls") {
    kind = "pull";
  } else if (category === "issues") {
    kind = "issue";
  }
  if (!kind) {
    throw new Error("URL must point to /issues/<number> or /pull/<number>.");
  }
  return { owner, repo, number, kind };
}

function createLogger(isVerbose: boolean) {
  return {
    debug: isVerbose ? console.debug.bind(console) : () => undefined,
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
}

async function buildContext(parsed: ParsedUrl) {
  const token = Deno.env.get("GITHUB_TOKEN")?.trim() ?? "";
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN in environment.");
  }
  const octokitWithRest = Octokit.plugin(restEndpointMethods);
  const octokit = new octokitWithRest({
    auth: token,
    request: { fetch: fetch.bind(globalThis) },
  });

  const repository = { owner: { login: parsed.owner }, name: parsed.repo };

  if (parsed.kind === "pull") {
    const { data } = await octokit.rest.pulls.get({
      owner: parsed.owner,
      repo: parsed.repo,
      pull_number: parsed.number,
    });
    const payload = {
      repository,
      pull_request: {
        node_id: data.node_id,
        number: data.number,
        title: data.title,
        html_url: data.html_url ?? data.url,
        created_at: data.created_at,
      },
    };
    return { octokit, payload };
  }

  const { data } = await octokit.rest.issues.get({
    owner: parsed.owner,
    repo: parsed.repo,
    issue_number: parsed.number,
  });
  const payload = {
    repository,
    issue: {
      node_id: data.node_id,
      number: data.number,
      title: data.title,
      html_url: data.html_url ?? data.url,
      created_at: data.created_at,
      pull_request: data.pull_request ?? undefined,
    },
  };
  return { octokit, payload };
}

async function main() {
  const { url, options } = parseArgs(Deno.args);
  if (!url) {
    console.log(USAGE);
    Deno.exit(1);
  }

  let parsed: ParsedUrl;
  try {
    parsed = parseGithubUrl(url);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
    return;
  }

  const { octokit, payload } = await buildContext(parsed);
  const logger = createLogger(options.isVerbose);
  const context = { payload, octokit, logger } as unknown as GitHubContext;
  const isColorEnabled = resolveColorMode(options.colorMode);

  const conversation = await resolveConversationKeyForContext(context, logger);
  if (!conversation) {
    console.error("Failed to resolve conversation graph for the URL.");
    Deno.exit(1);
  }

  const linked = conversation.linked;
  const keyNodes = await listConversationNodesForKey(context, conversation.key, options.maxNodes, logger);
  const linkedIds = new Set(linked.map((node) => node.id));
  const kvNodes = keyNodes.filter((node) => node.id !== conversation.root.id && !linkedIds.has(node.id));

  console.log(colorize("Conversation Graph", "\u001b[1m", isColorEnabled));
  console.log(`URL: ${colorize(url, "\u001b[2m", isColorEnabled)}`);
  console.log(`Key: ${colorize(conversation.key, "\u001b[2m", isColorEnabled)}`);
  console.log("Root:");
  renderNodeList("", [conversation.root], isColorEnabled, { indent: "", showHeader: false });

  console.log("");
  renderNodeList("Links (direct/outbound)", linked, isColorEnabled);

  console.log("");
  renderNodeList("Memory (KV)", kvNodes, isColorEnabled);

  if (options.showNotes) {
    console.log("");
    console.log("Notes:");
    console.log("- Links are built from timeline cross-references + outbound references in the issue body and recent comments.");
    console.log("- Memory (KV) lists previously merged nodes tied to this conversation key.");
  }

  if (options.showContext) {
    const contextText = await buildConversationContext({
      context,
      conversation,
      maxItems: 8,
      maxChars: 3200,
      includeSemantic: options.includeSemantic,
    });
    console.log("");
    console.log("ConversationContext:");
    console.log(contextText || "(empty)");
  }
}

if (import.meta.main) {
  void main();
}
