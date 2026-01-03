import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { config as loadEnv } from "dotenv";
import type { GitHubContext } from "../src/github/github-context.ts";
import { type ConversationNode, listConversationNodesForKey, resolveConversationKeyForContext } from "../src/github/utils/conversation-graph.ts";
import { fetchVectorDocument, fetchVectorDocuments, findSimilarIssues, getVectorDbConfig, type VectorDocument } from "../src/github/utils/vector-db.ts";

type Options = Readonly<{
  includeSemantic: boolean;
  includeComments: boolean;
  maxNodes: number;
  maxComments: number;
  isVerbose: boolean;
  colorMode: "auto" | "always" | "never";
}>;

type ParsedUrl = Readonly<{
  owner: string;
  repo: string;
  number: number;
  kind: "issue" | "pull";
}>;

loadEnv({ path: ".env" });

const DEFAULT_MAX_NODES = 40;
const DEFAULT_MAX_COMMENTS = 8;
const TITLE_MAX_CHARS = 120;
const COMMENT_SNIPPET_CHARS = 120;
const DEFAULT_SEMANTIC_THRESHOLD = 0.8;
const DEFAULT_SEMANTIC_TOP_K = 5;
const USAGE = `
Render an ASCII conversation graph from a GitHub issue/PR URL.

Usage:
  deno run -A --sloppy-imports scripts/conversation-graph.ts <github-url> [options]

Options:
  --no-semantic     Hide similarity matches
  --no-comments     Hide comment leaves
  --max-nodes=N     Limit number of KV nodes shown (default: ${DEFAULT_MAX_NODES})
  --max-comments=N  Limit number of comments shown per node (default: ${DEFAULT_MAX_COMMENTS})
  --verbose         Print debug warnings from graph resolution
  --color           Force ANSI color output
  --no-color        Disable ANSI color output
  --semantic        (default) Include similarity matches
  --comments        (default) Include comment leaves
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

type CommentKind = "IssueComment" | "ReviewComment" | "Review";

type CommentNode = Readonly<{
  id: string;
  kind: CommentKind;
  createdAt: string;
  url: string;
  author: string;
  body: string;
}>;

type CommentList = Readonly<{
  total: number;
  nodes: CommentNode[];
}>;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatDateLabel(value: string): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toISOString().slice(0, 10);
}

function getCommentKindLabel(kind: CommentKind): string {
  switch (kind) {
    case "IssueComment":
      return "Issue Comment";
    case "ReviewComment":
      return "Review Comment";
    case "Review":
      return "Review";
    default:
      return "Comment";
  }
}

function formatCommentNode(node: CommentNode): string {
  const kindLabel = getCommentKindLabel(node.kind);
  const authorLabel = node.author ? `@${node.author}` : "unknown";
  const dateLabel = formatDateLabel(node.createdAt);
  const snippet = node.body ? truncate(node.body, COMMENT_SNIPPET_CHARS) : "";
  const meta = [authorLabel, dateLabel].filter(Boolean).join(" ");
  const snippetLabel = snippet ? ` - ${snippet}` : "";
  return `[${kindLabel}] ${meta}${snippetLabel}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseOwnerRepoFromUrl(url: string): { owner: string; repo: string } {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return { owner: parts[0], repo: parts[1] };
    }
  } catch {
    return { owner: "", repo: "" };
  }
  return { owner: "", repo: "" };
}

function buildNodeFromVectorDocument(doc: VectorDocument): ConversationNode | null {
  if (doc.docType !== "issue" && doc.docType !== "pull_request") return null;
  const payload = isRecord(doc.payload) ? (doc.payload as Record<string, unknown>) : null;
  if (!payload) return null;

  const repository = isRecord(payload.repository) ? payload.repository : null;
  let owner = "";
  let repo = "";
  if (isRecord(repository?.owner)) {
    const ownerLogin = repository.owner.login;
    if (typeof ownerLogin === "string") owner = ownerLogin.trim();
  }
  if (typeof repository?.name === "string") repo = repository.name;

  let source: Record<string, unknown> | null = null;
  if (doc.docType === "issue") {
    source = isRecord(payload.issue) ? payload.issue : payload;
  } else {
    source = isRecord(payload.pull_request) ? payload.pull_request : payload;
  }
  if (!isRecord(source)) return null;

  const createdAt = typeof source.created_at === "string" ? source.created_at : "";
  let url = "";
  if (typeof source.html_url === "string") {
    url = source.html_url;
  } else if (typeof source.url === "string") {
    url = source.url;
  }
  const number = typeof source.number === "number" ? source.number : undefined;
  const title = typeof source.title === "string" ? source.title : undefined;
  const type: ConversationNode["type"] = doc.docType === "issue" ? "Issue" : "PullRequest";

  if ((!owner || !repo) && url) {
    const parsed = parseOwnerRepoFromUrl(url);
    owner = owner || parsed.owner;
    repo = repo || parsed.repo;
  }

  if (!createdAt || !url || !owner || !repo) return null;
  return {
    id: doc.id,
    type,
    createdAt,
    url,
    owner,
    repo,
    number,
    title,
  };
}

function buildCommentNode(kind: CommentKind, payload: Record<string, unknown>): CommentNode | null {
  let id = "";
  if (typeof payload.id === "number") {
    id = String(payload.id);
  } else if (typeof payload.id === "string") {
    id = payload.id;
  }
  const createdAt = typeof payload.created_at === "string" ? payload.created_at : "";
  const submittedAt = typeof payload.submitted_at === "string" ? payload.submitted_at : "";
  let url = "";
  if (typeof payload.html_url === "string") {
    url = payload.html_url;
  } else if (typeof payload.url === "string") {
    url = payload.url;
  }
  const user = isRecord(payload.user) ? payload.user : null;
  const author = typeof user?.login === "string" ? user.login.trim() : "";
  const rawBody = typeof payload.body === "string" ? payload.body : "";
  const body = normalizeWhitespace(rawBody);
  const timestamp = createdAt || submittedAt;
  if (!id || !url || !timestamp) return null;
  return {
    id,
    kind,
    createdAt: timestamp,
    url,
    author,
    body,
  };
}

function dedupeCommentNodes(nodes: CommentNode[]): CommentNode[] {
  const seen = new Set<string>();
  const out: CommentNode[] = [];
  for (const node of nodes) {
    const key = `${node.kind}:${node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node);
  }
  return out;
}

function sortCommentsByDate(nodes: CommentNode[]): CommentNode[] {
  return [...nodes].sort((a, b) => {
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    const aScore = Number.isFinite(aTime) ? aTime : 0;
    const bScore = Number.isFinite(bTime) ? bTime : 0;
    return bScore - aScore;
  });
}

async function fetchIssueCommentNodes(context: GitHubContext, node: ConversationNode, perPage: number): Promise<CommentNode[]> {
  if (node.number === undefined) return [];
  try {
    const { data } = await context.octokit.rest.issues.listComments({
      owner: node.owner,
      repo: node.repo,
      issue_number: node.number,
      per_page: perPage,
      sort: "created",
      direction: "desc",
    });
    const nodes: CommentNode[] = [];
    for (const comment of data ?? []) {
      const parsed = isRecord(comment) ? buildCommentNode("IssueComment", comment) : null;
      if (parsed) nodes.push(parsed);
    }
    return nodes;
  } catch (error) {
    context.logger.debug({ err: error, nodeId: node.id }, "Failed to fetch issue comments (non-fatal)");
    return [];
  }
}

async function fetchPullCommentNodes(context: GitHubContext, node: ConversationNode, perPage: number): Promise<CommentNode[]> {
  if (node.number === undefined) return [];
  const nodes: CommentNode[] = [];
  try {
    const { data } = await context.octokit.rest.issues.listComments({
      owner: node.owner,
      repo: node.repo,
      issue_number: node.number,
      per_page: perPage,
      sort: "created",
      direction: "desc",
    });
    for (const comment of data ?? []) {
      const parsed = isRecord(comment) ? buildCommentNode("IssueComment", comment) : null;
      if (parsed) nodes.push(parsed);
    }
  } catch (error) {
    context.logger.debug({ err: error, nodeId: node.id }, "Failed to fetch PR issue comments (non-fatal)");
  }

  try {
    const { data } = await context.octokit.rest.pulls.listReviewComments({
      owner: node.owner,
      repo: node.repo,
      pull_number: node.number,
      per_page: perPage,
    });
    for (const comment of data ?? []) {
      const parsed = isRecord(comment) ? buildCommentNode("ReviewComment", comment) : null;
      if (parsed) nodes.push(parsed);
    }
  } catch (error) {
    context.logger.debug({ err: error, nodeId: node.id }, "Failed to fetch PR review comments (non-fatal)");
  }

  try {
    const { data } = await context.octokit.rest.pulls.listReviews({
      owner: node.owner,
      repo: node.repo,
      pull_number: node.number,
      per_page: perPage,
    });
    for (const review of data ?? []) {
      const parsed = isRecord(review) ? buildCommentNode("Review", review) : null;
      if (parsed) nodes.push(parsed);
    }
  } catch (error) {
    context.logger.debug({ err: error, nodeId: node.id }, "Failed to fetch PR reviews (non-fatal)");
  }

  return nodes;
}

async function fetchCommentsForNode(context: GitHubContext, node: ConversationNode, maxComments: number): Promise<CommentList> {
  if (maxComments <= 0) return { total: 0, nodes: [] };
  const perPage = Math.min(100, Math.max(1, maxComments));
  const rawNodes = node.type === "PullRequest" ? await fetchPullCommentNodes(context, node, perPage) : await fetchIssueCommentNodes(context, node, perPage);
  const deduped = dedupeCommentNodes(rawNodes);
  const sorted = sortCommentsByDate(deduped);
  return {
    total: sorted.length,
    nodes: sorted.slice(0, maxComments),
  };
}

async function fetchCommentsForNodes(context: GitHubContext, nodes: ConversationNode[], maxComments: number): Promise<Map<string, CommentList>> {
  const map = new Map<string, CommentList>();
  for (const node of nodes) {
    const list = await fetchCommentsForNode(context, node, maxComments);
    map.set(node.id, list);
  }
  return map;
}

function supportsColor(): boolean {
  const forceColor = Deno.env.get("FORCE_COLOR");
  const noColor = Deno.env.get("NO_COLOR");
  const term = (Deno.env.get("TERM") ?? "").toLowerCase();
  if (forceColor !== undefined) return forceColor !== "0";
  if (noColor !== undefined) return false;
  if (term !== "" && term !== "dumb") return true;
  const stdout = (globalThis as { Deno?: { stdout?: { isTerminal?: () => boolean } } }).Deno?.stdout;
  return typeof stdout?.isTerminal === "function" ? stdout.isTerminal() : false;
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

const COLOR = {
  header: "\u001b[1m",
  label: "\u001b[33m",
  value: "\u001b[36m",
  dim: "\u001b[2m",
  error: "\u001b[31m",
};

function styleHeader(text: string, isColorEnabled: boolean): string {
  return colorize(text, COLOR.header, isColorEnabled);
}

function styleLabel(text: string, isColorEnabled: boolean): string {
  return colorize(text, COLOR.label, isColorEnabled);
}

function styleValue(text: string, isColorEnabled: boolean): string {
  return colorize(text, COLOR.value, isColorEnabled);
}

function styleDim(text: string, isColorEnabled: boolean): string {
  return colorize(text, COLOR.dim, isColorEnabled);
}

function formatSectionHeader(title: string, count: number | string | null, isColorEnabled: boolean): string {
  const label = styleLabel(title, isColorEnabled);
  if (count === null) return label;
  const countLabel = `[${count}]`;
  return `${label} ${styleDim(countLabel, isColorEnabled)}`;
}

function renderSection(title: string, options: Readonly<{ count?: number | string; isLast: boolean; isColorEnabled: boolean; indent?: string }>): string {
  const branch = options.isLast ? "`--" : "|--";
  const indent = options.indent ?? "";
  const header = formatSectionHeader(title, options.count ?? null, options.isColorEnabled);
  console.log(`${indent}${styleDim(branch, options.isColorEnabled)} ${header}`);
  return `${indent}${options.isLast ? "    " : "|   "}`;
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
    const countLabel = styleDim(`[${nodes.length}]`, isColorEnabled);
    const titleLabel = styleLabel(title, isColorEnabled);
    console.log(`${indent}${titleLabel} ${countLabel}`);
  }
  if (!nodes.length) {
    console.log(`${indent}\`-- ${styleDim("(none)", isColorEnabled)}`);
    return;
  }
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const branch = isLast ? "`--" : "|--";
    const childIndent = isLast ? "    " : "|   ";
    const nodeText = formatNode(node);
    console.log(`${indent}${styleDim(branch, isColorEnabled)} ${styleValue(nodeText, isColorEnabled)}`);
    if (node.url) {
      console.log(`${indent}${childIndent}${styleDim(node.url, isColorEnabled)}`);
    }
  });
}

function renderCommentList(nodes: CommentNode[], isColorEnabled: boolean, indent: string): void {
  if (!nodes.length) {
    console.log(`${indent}\`-- ${styleDim("(none)", isColorEnabled)}`);
    return;
  }
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const branch = isLast ? "`--" : "|--";
    const childIndent = isLast ? "    " : "|   ";
    const nodeText = formatCommentNode(node);
    console.log(`${indent}${styleDim(branch, isColorEnabled)} ${styleValue(nodeText, isColorEnabled)}`);
    if (node.url) {
      console.log(`${indent}${childIndent}${styleDim(node.url, isColorEnabled)}`);
    }
  });
}

function renderNodeListWithComments(
  nodes: ConversationNode[],
  commentsById: Map<string, CommentList>,
  isColorEnabled: boolean,
  options: Readonly<{ indent?: string; showHeader?: boolean }> = {}
): void {
  const indent = options.indent ?? "";
  const showHeader = options.showHeader !== false;
  if (showHeader) {
    const countLabel = styleDim(`[${nodes.length}]`, isColorEnabled);
    const titleLabel = styleLabel("Nodes", isColorEnabled);
    console.log(`${indent}${titleLabel} ${countLabel}`);
  }
  if (!nodes.length) {
    console.log(`${indent}\`-- ${styleDim("(none)", isColorEnabled)}`);
    return;
  }
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const branch = isLast ? "`--" : "|--";
    const childIndent = isLast ? "    " : "|   ";
    const nodeText = formatNode(node);
    console.log(`${indent}${styleDim(branch, isColorEnabled)} ${styleValue(nodeText, isColorEnabled)}`);
    if (node.url) {
      console.log(`${indent}${childIndent}${styleDim(node.url, isColorEnabled)}`);
    }

    const commentList = commentsById.get(node.id);
    if (commentList && commentList.nodes.length > 0) {
      const countLabel = commentList.total > commentList.nodes.length ? `${commentList.nodes.length}/${commentList.total}` : commentList.total;
      const sectionIndent = renderSection("Comments", {
        count: countLabel,
        isLast: true,
        isColorEnabled,
        indent: `${indent}${childIndent}`,
      });
      renderCommentList(commentList.nodes, isColorEnabled, sectionIndent);
    }
  });
}

type SimilarityStatus = "disabled" | "missing-config" | "missing-document" | "missing-embedding" | "no-results" | "ok";

type SimilarityMatch = Readonly<{
  node: ConversationNode;
  similarity: number;
}>;

type SimilarityInfo = Readonly<{
  status: SimilarityStatus;
  matches: SimilarityMatch[];
}>;

async function getSimilarityMatches(context: GitHubContext, rootId: string, includeSemantic: boolean): Promise<SimilarityInfo> {
  if (!includeSemantic) {
    return { status: "disabled", matches: [] };
  }

  const config = getVectorDbConfig(context.logger);
  if (!config) {
    return { status: "missing-config", matches: [] };
  }

  const rootDoc = await fetchVectorDocument(config, rootId);
  if (!rootDoc) {
    return { status: "missing-document", matches: [] };
  }

  const embedding = Array.isArray(rootDoc.embedding) ? rootDoc.embedding : [];
  if (embedding.length === 0) {
    return { status: "missing-embedding", matches: [] };
  }

  const results = await findSimilarIssues(config, {
    currentId: rootId,
    embedding,
    threshold: DEFAULT_SEMANTIC_THRESHOLD,
    topK: DEFAULT_SEMANTIC_TOP_K,
  });

  if (results.length === 0) {
    return { status: "no-results", matches: [] };
  }

  const docs = await fetchVectorDocuments(
    config,
    results.map((row) => row.id)
  );
  const docMap = new Map(docs.map((doc) => [doc.id, doc]));
  const matches = results
    .map((row) => {
      const doc = docMap.get(row.id);
      const node = doc ? buildNodeFromVectorDocument(doc) : null;
      if (!node) return null;
      return { node, similarity: row.similarity };
    })
    .filter((entry): entry is SimilarityMatch => Boolean(entry));

  if (!matches.length) {
    return { status: "no-results", matches: [] };
  }

  return { status: "ok", matches };
}

function formatSimilarityTitle(status: SimilarityStatus): string {
  switch (status) {
    case "disabled":
      return "Similarity (disabled)";
    case "missing-config":
      return "Similarity (missing vector DB)";
    case "missing-document":
      return "Similarity (root missing)";
    case "missing-embedding":
      return "Similarity (root embedding missing)";
    default:
      return "Similarity";
  }
}

function parseArgs(args: string[]): { url: string | null; options: Options } {
  let url: string | null = null;
  let includeSemantic = true;
  let includeComments = true;
  let maxNodes = DEFAULT_MAX_NODES;
  let maxComments = DEFAULT_MAX_COMMENTS;
  let isVerbose = false;
  let colorMode: Options["colorMode"] = "auto";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      Deno.exit(0);
    }
    if (arg === "--context" || arg === "--no-context") {
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
      maxNodes = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--max-nodes=")) {
      maxNodes = Number(arg.split("=").slice(1).join("="));
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
  if (!Number.isFinite(maxComments) || maxComments < 0) {
    maxComments = DEFAULT_MAX_COMMENTS;
  }

  return { url, options: { includeSemantic, includeComments, maxNodes, maxComments, isVerbose, colorMode } };
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
  const commentTargets = options.includeComments ? [conversation.root, ...linked] : [];
  const commentMap = options.includeComments ? await fetchCommentsForNodes(context, commentTargets, options.maxComments) : new Map();

  console.log(styleHeader("Conversation Graph", isColorEnabled));
  console.log(`${styleLabel("Root:", isColorEnabled)} ${styleValue(formatNode(conversation.root), isColorEnabled)}`);
  if (conversation.root.url) {
    console.log(`  ${styleDim(conversation.root.url, isColorEnabled)}`);
  }

  const rootComments = commentMap.get(conversation.root.id);
  if (rootComments && rootComments.nodes.length > 0) {
    const countLabel = rootComments.total > rootComments.nodes.length ? `${rootComments.nodes.length}/${rootComments.total}` : rootComments.total;
    const commentsIndent = renderSection("Comments", { count: countLabel, isLast: false, isColorEnabled });
    renderCommentList(rootComments.nodes, isColorEnabled, commentsIndent);
  }

  const linksIndent = renderSection("Links", { count: linked.length, isLast: false, isColorEnabled });
  renderNodeListWithComments(linked, commentMap, isColorEnabled, { indent: linksIndent, showHeader: false });

  const memoryIndent = renderSection("Memory (merged history)", { count: kvNodes.length, isLast: false, isColorEnabled });
  if (kvNodes.length > 0) {
    renderNodeList("", kvNodes, isColorEnabled, { indent: memoryIndent, showHeader: false });
  } else {
    console.log(`${memoryIndent}\`-- ${styleDim("(none yet; populated when this key merges related threads)", isColorEnabled)}`);
  }

  const similarityInfo = await getSimilarityMatches(context, conversation.root.id, options.includeSemantic);
  const similarityTitle = formatSimilarityTitle(similarityInfo.status);
  const similarityIndent = renderSection(similarityTitle, { count: similarityInfo.matches.length, isLast: true, isColorEnabled });
  renderNodeList(
    "",
    similarityInfo.matches.map((match) => match.node),
    isColorEnabled,
    { indent: similarityIndent, showHeader: false }
  );
}

if (import.meta.main) {
  void main();
}
