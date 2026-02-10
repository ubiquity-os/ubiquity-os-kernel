import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { config as loadEnv } from "dotenv";
import type { GitHubContext } from "../src/github/github-context.ts";
import { buildConversationContext } from "../src/github/utils/conversation-context.ts";
import { resolveConversationKeyForContext } from "../src/github/utils/conversation-graph.ts";

type Options = Readonly<{
  url: string;
  query: string;
  maxItems: number;
  maxComments: number;
  maxCommentChars: number;
  maxChars: number;
  includeSemantic: boolean;
  includeComments: boolean;
  useSelector: boolean;
  includeGraph: boolean;
  runSelector: boolean;
  runSummary: boolean;
  maxSelect: number;
  model: string;
  json: boolean;
  outPath: string;
  quiet: boolean;
}>;

loadEnv({ path: ".env" });

const DEFAULT_MAX_ITEMS = 8;
const DEFAULT_MAX_COMMENTS = 8;
const DEFAULT_MAX_COMMENT_CHARS = 280;
const DEFAULT_MAX_CHARS = 6000;
const ISSUE_JSON_PATH = ".ubiquityos.issue.json";
const USAGE = `
Build a compact conversation context for an issue/PR.

Usage:
  deno run -A --sloppy-imports scripts/agent-context.ts <github-url> [options]

Options:
  --query "<text>"          Optional task query (for logging; selector disabled in CLI).
  --max-items N             Max linked nodes to include (default: ${DEFAULT_MAX_ITEMS})
  --max-comments N          Max comments per node (default: ${DEFAULT_MAX_COMMENTS})
  --max-comment-chars N     Max chars per comment (default: ${DEFAULT_MAX_COMMENT_CHARS})
  --max-chars N             Max total chars (default: ${DEFAULT_MAX_CHARS})
  --semantic                Enable vector-db similarity expansion (default)
  --no-semantic             Disable vector-db similarity expansion
  --comments                Include comment bodies (default)
  --no-comments             Exclude comment bodies
  --graph                   Print raw conversation context (default)
  --no-graph                Suppress raw context output
  --select                  Use LLM to choose most relevant blocks
  --summary                 Use LLM to summarize (uses selected blocks if available)
  --max-select N            Max selected blocks (default: 12)
  --selector                Enable graph node selector when query is present
  --no-selector             Disable graph node selector
  --model <name>            LLM model (default: gpt-5.3-chat-latest)
  --json                    Output JSON { key, query, graph, selected, summary }
  --out <path>              Write raw context to a file
  --quiet                   Suppress stdout when writing to file
  -h, --help                Show this help

LLM selection/summary requires UOS_AI with a token.

Tip: If no URL is provided, the tool will try to read ${ISSUE_JSON_PATH}.
`.trim();

function readIssueUrlFromFile(path: string): string {
  try {
    const raw = Deno.readTextFileSync(path);
    const data = JSON.parse(raw) as Record<string, unknown>;
    const url = typeof data.html_url === "string" ? data.html_url : "";
    return url.trim();
  } catch {
    return "";
  }
}

function parseGithubUrl(input: string): { owner: string; repo: string; number: number; kind: "issue" | "pull" } {
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
  let kind: "issue" | "pull" | null = null;
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

function parseArgs(args: string[]): Options {
  let url = "";
  let query = "";
  let maxItems = DEFAULT_MAX_ITEMS;
  let maxComments = DEFAULT_MAX_COMMENTS;
  let maxCommentChars = DEFAULT_MAX_COMMENT_CHARS;
  let maxChars = DEFAULT_MAX_CHARS;
  let includeSemantic = true;
  let includeComments = true;
  let useSelectorOverride: boolean | null = null;
  let includeGraph = true;
  let shouldRunSelector = false;
  let shouldRunSummary = false;
  let maxSelect = 12;
  let model = "gpt-5.3-chat-latest";
  let useJson = false;
  let outPath = "";
  let isQuiet = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      Deno.exit(0);
    }
    if (arg === "--query" && args[i + 1]) {
      query = String(args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg.startsWith("--query=")) {
      query = arg.split("=").slice(1).join("=");
      continue;
    }
    if (arg === "--max-items" && args[i + 1]) {
      maxItems = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--max-items=")) {
      maxItems = Number(arg.split("=").slice(1).join("="));
      continue;
    }
    if (arg === "--max-comments" && args[i + 1]) {
      maxComments = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--max-comments=")) {
      maxComments = Number(arg.split("=").slice(1).join("="));
      continue;
    }
    if (arg === "--max-comment-chars" && args[i + 1]) {
      maxCommentChars = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--max-comment-chars=")) {
      maxCommentChars = Number(arg.split("=").slice(1).join("="));
      continue;
    }
    if (arg === "--max-chars" && args[i + 1]) {
      maxChars = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--max-chars=")) {
      maxChars = Number(arg.split("=").slice(1).join("="));
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
    if (arg === "--comments") {
      includeComments = true;
      continue;
    }
    if (arg === "--no-comments") {
      includeComments = false;
      continue;
    }
    if (arg === "--graph") {
      includeGraph = true;
      continue;
    }
    if (arg === "--no-graph") {
      includeGraph = false;
      continue;
    }
    if (arg === "--select") {
      shouldRunSelector = true;
      continue;
    }
    if (arg === "--summary") {
      shouldRunSummary = true;
      continue;
    }
    if (arg === "--max-select" && args[i + 1]) {
      maxSelect = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--max-select=")) {
      maxSelect = Number(arg.split("=").slice(1).join("="));
      continue;
    }
    if (arg === "--selector") {
      useSelectorOverride = true;
      continue;
    }
    if (arg === "--no-selector") {
      useSelectorOverride = false;
      continue;
    }
    if (arg === "--model" && args[i + 1]) {
      model = String(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.split("=").slice(1).join("=");
      continue;
    }
    if (arg === "--json") {
      useJson = true;
      continue;
    }
    if (arg === "--out" && args[i + 1]) {
      outPath = String(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      outPath = arg.split("=").slice(1).join("=");
      continue;
    }
    if (arg === "--quiet") {
      isQuiet = true;
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

  if (!url) {
    url = readIssueUrlFromFile(ISSUE_JSON_PATH);
  }
  if (!url) {
    console.error("Missing GitHub URL.");
    console.log(USAGE);
    Deno.exit(1);
  }

  if (!Number.isFinite(maxItems) || maxItems <= 0) maxItems = DEFAULT_MAX_ITEMS;
  if (!Number.isFinite(maxComments) || maxComments < 0) maxComments = DEFAULT_MAX_COMMENTS;
  if (!Number.isFinite(maxCommentChars) || maxCommentChars <= 0) maxCommentChars = DEFAULT_MAX_COMMENT_CHARS;
  if (!Number.isFinite(maxChars) || maxChars <= 0) maxChars = DEFAULT_MAX_CHARS;

  if (!Number.isFinite(maxSelect) || maxSelect <= 0) maxSelect = 12;

  return {
    url,
    query,
    maxItems,
    maxComments,
    maxCommentChars,
    maxChars,
    includeSemantic,
    includeComments,
    useSelector: useSelectorOverride ?? query.trim().length > 0,
    includeGraph,
    runSelector: shouldRunSelector,
    runSummary: shouldRunSummary,
    maxSelect,
    model,
    json: useJson,
    outPath,
    quiet: isQuiet,
  };
}

function getToken(): string {
  const token = Deno.env.get("GITHUB_TOKEN") || Deno.env.get("GH_TOKEN") || "";
  return token.trim();
}

async function buildContext(parsed: { owner: string; repo: string; number: number; kind: "issue" | "pull" }) {
  const token = getToken();
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN or GH_TOKEN in environment.");
  }
  const octokitWithRestCtor = Octokit.plugin(restEndpointMethods);
  const octokit = new octokitWithRestCtor({
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

function createLogger() {
  return {
    debug: () => {},
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
}

type ContextBlock = Readonly<{
  id: number;
  kind: "node" | "comment";
  text: string;
}>;

function splitContextBlocks(raw: string): ContextBlock[] {
  const lines = raw.split("\n");
  const blocks: ContextBlock[] = [];
  let current: string[] = [];
  let currentKind: "node" | "comment" | null = null;
  const flush = () => {
    if (!currentKind || current.length === 0) return;
    blocks.push({ id: blocks.length + 1, kind: currentKind, text: current.join("\n").trimEnd() });
    current = [];
    currentKind = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentKind) current.push(line);
      continue;
    }
    const isTopLevel = line.trimStart() === line;
    const isBlockStart = /^-\s*\[/.test(trimmed) || /^ {2}-\s*\[/.test(line);
    if (isBlockStart) {
      flush();
      currentKind = isTopLevel ? "node" : "comment";
      current.push(line);
      continue;
    }
    if (currentKind) {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

type AiConfig = Readonly<{
  baseUrl: string;
  token: string;
}>;

function loadAiConfig(): AiConfig {
  const raw = Deno.env.get("UOS_AI");
  if (!raw || !raw.trim()) {
    throw new Error("Missing UOS_AI config for LLM selection/summary.");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid UOS_AI JSON.");
  }
  const baseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "https://ai-ubq-fi.deno.dev";
  const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
  if (!token) {
    throw new Error("UOS_AI.token is required for LLM selection/summary.");
  }
  return { baseUrl, token };
}

async function callChatCompletion(
  config: AiConfig,
  model: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: Readonly<{ temperature?: number; timeoutMs?: number }> = {}
): Promise<string> {
  const payload = {
    model,
    reasoning_effort: "none",
    stream: false,
    temperature: options.temperature ?? 0,
    messages,
  };
  const endpoint = new URL("/v1/chat/completions", config.baseUrl).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 25_000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        "User-Agent": "ubiquityos-agent-context",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${endpoint} -> ${res.status} ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } | null } | null> | null };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("Missing assistant content.");
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonIds(raw: string): number[] {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as { includeIds?: unknown };
    const ids = Array.isArray(parsed?.includeIds) ? parsed.includeIds : [];
    return ids.filter((id): id is number => typeof id === "number" && Number.isFinite(id));
  } catch {
    return [];
  }
}

async function selectRelevantBlocks(params: { blocks: ContextBlock[]; query: string; model: string; maxSelect: number }): Promise<ContextBlock[]> {
  const config = loadAiConfig();
  const maxSelect = Math.max(1, Math.trunc(params.maxSelect));
  const blockText = params.blocks.map((block) => `ID ${block.id} (${block.kind}):\n${block.text}`).join("\n\n");
  const prompt = [
    "You are a selector. Choose the minimal set of blocks needed to answer the query.",
    "Return ONLY JSON in this shape:",
    `{ "includeIds": [1, 2] }`,
    `Rules: use only provided IDs; choose at most ${maxSelect} IDs; prefer fewer IDs; return [] if nothing is relevant.`,
  ].join("\n");
  const response = await callChatCompletion(
    config,
    params.model,
    [
      { role: "system", content: prompt },
      { role: "user", content: `Query:\n${params.query}\n\nBlocks:\n${blockText}` },
    ],
    { temperature: 0 }
  );
  const ids = parseJsonIds(response);
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  return params.blocks.filter((block) => idSet.has(block.id)).slice(0, maxSelect);
}

async function summarizeBlocks(params: { text: string; query: string; model: string }): Promise<string> {
  const config = loadAiConfig();
  const prompt = [
    "Summarize the relevant context for the query.",
    "Be concise. Use bullets for key decisions, blockers, and next steps.",
    "If the context does not answer the query, say so explicitly.",
  ].join("\n");
  return await callChatCompletion(
    config,
    params.model,
    [
      { role: "system", content: prompt },
      { role: "user", content: `Query:\n${params.query}\n\nContext:\n${params.text}` },
    ],
    { temperature: 0.2 }
  );
}

async function main() {
  const options = parseArgs(Deno.args);
  let parsedUrl: { owner: string; repo: string; number: number; kind: "issue" | "pull" };
  try {
    parsedUrl = parseGithubUrl(options.url);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
    return;
  }

  const { octokit, payload } = await buildContext(parsedUrl);
  const logger = createLogger();
  const context = { payload, octokit, logger } as unknown as GitHubContext;
  const conversation = await resolveConversationKeyForContext(context, logger);
  if (!conversation) {
    console.error("Failed to resolve conversation graph for the URL.");
    Deno.exit(1);
    return;
  }

  const useSelector = options.runSelector ? false : options.useSelector;
  const conversationContext = await buildConversationContext({
    context,
    conversation,
    maxItems: options.maxItems,
    maxChars: options.maxChars,
    includeSemantic: options.includeSemantic,
    includeComments: options.includeComments,
    maxComments: options.maxComments,
    maxCommentChars: options.maxCommentChars,
    query: options.query,
    useSelector,
  });

  let selectedBlocks: ContextBlock[] = [];
  let selectedText = "";
  if (options.runSelector) {
    if (!options.query.trim()) {
      console.error("Selection requires --query.");
      Deno.exit(1);
      return;
    }
    const blocks = splitContextBlocks(conversationContext);
    selectedBlocks = await selectRelevantBlocks({
      blocks,
      query: options.query,
      model: options.model,
      maxSelect: options.maxSelect,
    });
    selectedText = selectedBlocks.map((block) => block.text).join("\n\n");
  }

  let summary = "";
  if (options.runSummary) {
    if (!options.query.trim()) {
      console.error("Summary requires --query.");
      Deno.exit(1);
      return;
    }
    const source = selectedText || conversationContext;
    summary = await summarizeBlocks({
      text: source,
      query: options.query,
      model: options.model,
    });
  }

  if (options.json) {
    const output = {
      key: conversation.key,
      query: options.query || "",
      graph: conversationContext,
      selected: selectedText,
      summary,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (options.outPath) {
    Deno.writeTextFileSync(options.outPath, conversationContext);
  }

  if (options.quiet && options.outPath) {
    return;
  }

  const header = ["Conversation context", `Key: ${conversation.key}`, options.query ? `Query: ${options.query}` : null].filter(Boolean).join("\n");
  if (options.includeGraph) {
    console.log(header);
    console.log("");
    console.log(conversationContext || "(empty)");
  }

  if (options.runSelector) {
    console.log("");
    console.log("Selected context");
    console.log("");
    console.log(selectedText || "(none selected)");
  }

  if (options.runSummary) {
    console.log("");
    console.log("Summary");
    console.log("");
    console.log(summary || "(empty)");
  }
}

if (import.meta.main) {
  await main();
}
