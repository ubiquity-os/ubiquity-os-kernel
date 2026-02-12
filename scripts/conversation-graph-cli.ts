export type Options = Readonly<{
  includeSemantic: boolean;
  includeComments: boolean;
  includeContext: boolean;
  maxNodes: number;
  maxComments: number;
  contextMaxItems: number;
  contextMaxChars: number;
  contextMaxComments: number;
  contextMaxCommentChars: number;
  isVerbose: boolean;
  colorMode: "auto" | "always" | "never";
}>;

export type ParsedUrl = Readonly<{
  owner: string;
  repo: string;
  number: number;
  kind: "issue" | "pull";
}>;

const DEFAULT_MAX_NODES = 40;
const DEFAULT_MAX_COMMENTS = 8;
const DEFAULT_CONTEXT_MAX_ITEMS = 8;
const DEFAULT_CONTEXT_MAX_CHARS = 3200;
const DEFAULT_CONTEXT_MAX_COMMENTS = 8;
const DEFAULT_CONTEXT_MAX_COMMENT_CHARS = 256;
const UNLIMITED = Number.POSITIVE_INFINITY;

export const USAGE = `
Render an ASCII conversation graph from a GitHub issue/PR URL.

Usage:
  deno run -A --sloppy-imports scripts/conversation-graph.ts <github-url> [options]

Options:
  --no-semantic     Hide similarity matches
  --no-comments     Hide comment leaves
  --context         Print conversationContext preview (agent input)
  --no-context      Skip conversationContext preview (default)
  --all             Show all nodes/comments (no limits)
  --max-output=N    Set max nodes and comments to N (use "all" for unlimited)
  --max-nodes=N     Limit number of KV nodes shown (default: ${DEFAULT_MAX_NODES})
  --max-comments=N  Limit number of comments shown per node (default: ${DEFAULT_MAX_COMMENTS})
  --context-max-items=N         Max linked nodes in conversationContext (default: ${DEFAULT_CONTEXT_MAX_ITEMS})
  --context-max-chars=N         Max chars for conversationContext (default: ${DEFAULT_CONTEXT_MAX_CHARS})
  --context-max-comments=N      Max comments per node in conversationContext (default: ${DEFAULT_CONTEXT_MAX_COMMENTS})
  --context-max-comment-chars=N Max chars per comment in conversationContext (default: ${DEFAULT_CONTEXT_MAX_COMMENT_CHARS})
  --verbose         Print debug warnings from graph resolution
  --color           Force ANSI color output
  --no-color        Disable ANSI color output
  --semantic        (default) Include similarity matches
  --comments        (default) Include comment leaves
  -h, --help        Show this help
`.trim();

function parseLimitValue(raw: string): number {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "all") return UNLIMITED;
  return Number(raw);
}

function isUnlimitedLimit(value: number): boolean {
  return value === UNLIMITED;
}

export function parseArgs(args: string[]): { url: string | null; options: Options } {
  let url: string | null = null;
  let includeSemantic = true;
  let includeComments = true;
  let includeContext = false;
  let maxNodes = DEFAULT_MAX_NODES;
  let maxComments = DEFAULT_MAX_COMMENTS;
  let contextMaxItems = DEFAULT_CONTEXT_MAX_ITEMS;
  let contextMaxChars = DEFAULT_CONTEXT_MAX_CHARS;
  let contextMaxComments = DEFAULT_CONTEXT_MAX_COMMENTS;
  let contextMaxCommentChars = DEFAULT_CONTEXT_MAX_COMMENT_CHARS;
  let isVerbose = false;
  let colorMode: Options["colorMode"] = "auto";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      Deno.exit(0);
    }
    if (arg === "--context") {
      includeContext = true;
      continue;
    }
    if (arg === "--no-context") {
      includeContext = false;
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
    if (arg === "--all") {
      maxNodes = UNLIMITED;
      maxComments = UNLIMITED;
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
    if (arg === "--max-nodes" && args[i + 1]) {
      maxNodes = parseLimitValue(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--max-nodes=")) {
      maxNodes = parseLimitValue(arg.split("=").slice(1).join("="));
      continue;
    }
    if (arg === "--max-output" && args[i + 1]) {
      const parsed = parseLimitValue(args[i + 1]);
      maxNodes = parsed;
      maxComments = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--max-output=")) {
      const parsed = parseLimitValue(arg.split("=").slice(1).join("="));
      maxNodes = parsed;
      maxComments = parsed;
      continue;
    }
    if (arg === "--max-comments" && args[i + 1]) {
      maxComments = parseLimitValue(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--max-comments=")) {
      maxComments = parseLimitValue(arg.split("=").slice(1).join("="));
      continue;
    }
    if (arg === "--context-max-items" && args[i + 1]) {
      contextMaxItems = parseLimitValue(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--context-max-items=")) {
      contextMaxItems = parseLimitValue(arg.split("=").slice(1).join("="));
      continue;
    }
    if (arg === "--context-max-chars" && args[i + 1]) {
      contextMaxChars = parseLimitValue(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--context-max-chars=")) {
      contextMaxChars = parseLimitValue(arg.split("=").slice(1).join("="));
      continue;
    }
    if (arg === "--context-max-comments" && args[i + 1]) {
      contextMaxComments = parseLimitValue(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--context-max-comments=")) {
      contextMaxComments = parseLimitValue(arg.split("=").slice(1).join("="));
      continue;
    }
    if (arg === "--context-max-comment-chars" && args[i + 1]) {
      contextMaxCommentChars = parseLimitValue(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--context-max-comment-chars=")) {
      contextMaxCommentChars = parseLimitValue(arg.split("=").slice(1).join("="));
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

  if (!isUnlimitedLimit(maxNodes) && (!Number.isFinite(maxNodes) || maxNodes <= 0)) {
    maxNodes = DEFAULT_MAX_NODES;
  }
  if (!isUnlimitedLimit(maxComments) && (!Number.isFinite(maxComments) || maxComments < 0)) {
    maxComments = DEFAULT_MAX_COMMENTS;
  }

  return {
    url,
    options: {
      includeSemantic,
      includeComments,
      includeContext,
      maxNodes,
      maxComments,
      contextMaxItems,
      contextMaxChars,
      contextMaxComments,
      contextMaxCommentChars,
      isVerbose,
      colorMode,
    },
  };
}

export function parseGithubUrl(input: string): ParsedUrl {
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
