import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { config as loadEnv } from "dotenv";
import type { GitHubContext } from "../src/github/github-context.ts";
import { type ConversationNode, listConversationNodesForKey, resolveConversationKeyForContext } from "../src/github/utils/conversation-graph.ts";
import { buildConversationContext } from "../src/github/utils/conversation-context.ts";
import { fetchVectorDocuments, findSimilarComments, findSimilarIssues, getVectorDbConfig, type VectorDocument } from "../src/github/utils/vector-db.ts";
import { parseArgs, type ParsedUrl, parseGithubUrl, USAGE } from "./conversation-graph-cli.ts";
import {
  formatNode,
  renderCommentList,
  renderNodeList,
  renderNodeListWithComments,
  renderSection,
  renderSimilarityList,
  resolveColorMode,
  type SimilarityMatchDisplay,
  styleDim,
  styleHeader,
  styleLabel,
  styleValue,
} from "./conversation-graph-render.ts";

loadEnv({ path: ".env" });

const DEFAULT_CONTEXT_MAX_ITEMS = 8;
const DEFAULT_CONTEXT_MAX_CHARS = 3200;
const DEFAULT_CONTEXT_MAX_COMMENTS = 8;
const DEFAULT_CONTEXT_MAX_COMMENT_CHARS = 256;
const UNLIMITED = Number.POSITIVE_INFINITY;
const DEFAULT_SEMANTIC_THRESHOLD = 0.8;
const DEFAULT_SEMANTIC_TOP_K = 5;

function isUnlimitedLimit(value: number): boolean {
  return value === UNLIMITED;
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

function buildCommentNodeFromDocument(doc: VectorDocument): CommentNode | null {
  if (doc.docType !== "issue_comment" && doc.docType !== "review_comment" && doc.docType !== "pull_request_review") return null;
  const payload = isRecord(doc.payload) ? (doc.payload as Record<string, unknown>) : null;
  if (!payload) return null;
  const comment = isRecord(payload.comment) ? payload.comment : null;
  const review = isRecord(payload.review) ? payload.review : null;
  const source = comment ?? review;
  if (!isRecord(source)) return null;
  const createdAt = typeof source.created_at === "string" ? source.created_at : "";
  const submittedAt = typeof source.submitted_at === "string" ? source.submitted_at : "";
  const timestamp = createdAt || submittedAt;
  let url = "";
  if (typeof source.html_url === "string") {
    url = source.html_url;
  } else if (typeof source.url === "string") {
    url = source.url;
  }
  const user = isRecord(source.user) ? source.user : null;
  const author = typeof user?.login === "string" ? user.login.trim() : "";
  const rawBody = doc.markdown ?? (typeof source.body === "string" ? source.body : "");
  const body = normalizeWhitespace(rawBody);
  if (!doc.id || !url || !timestamp) return null;
  let kind: CommentKind = "Review";
  if (doc.docType === "issue_comment") {
    kind = "IssueComment";
  } else if (doc.docType === "review_comment") {
    kind = "ReviewComment";
  }
  return {
    id: doc.id,
    kind,
    createdAt: timestamp,
    url,
    author,
    body,
  };
}

function buildCommentNode(kind: CommentKind, payload: Record<string, unknown>): CommentNode | null {
  let id = "";
  if (typeof payload.node_id === "string") {
    id = payload.node_id;
  } else if (typeof payload.id === "number") {
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
  if (kind === "Review" && !body) return null;
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

async function fetchIssueCommentNodes(context: GitHubContext, node: ConversationNode, perPage: number, maxComments: number): Promise<CommentNode[]> {
  const nodeNumber = node.number;
  if (nodeNumber === undefined) return [];
  try {
    const raw = await fetchPagedItems(
      async (page, pageSize) => {
        const { data } = await context.octokit.rest.issues.listComments({
          owner: node.owner,
          repo: node.repo,
          issue_number: nodeNumber,
          per_page: pageSize,
          page,
          sort: "created",
          direction: "desc",
        });
        return data ?? [];
      },
      perPage,
      maxComments
    );
    const nodes: CommentNode[] = [];
    for (const comment of raw) {
      const parsed = isRecord(comment) ? buildCommentNode("IssueComment", comment) : null;
      if (parsed) nodes.push(parsed);
    }
    return nodes;
  } catch (error) {
    context.logger.debug({ err: error, nodeId: node.id }, "Failed to fetch issue comments (non-fatal)");
    return [];
  }
}

async function fetchPagedItems<T>(fetchPage: (page: number, perPage: number) => Promise<T[]>, perPage: number, maxItems: number): Promise<T[]> {
  const isUnlimited = isUnlimitedLimit(maxItems);
  const items: T[] = [];
  let page = 1;
  while (true) {
    const batch = await fetchPage(page, perPage);
    if (batch.length === 0) break;
    items.push(...batch);
    if (!isUnlimited && items.length >= maxItems) {
      return items.slice(0, maxItems);
    }
    if (batch.length < perPage) break;
    page += 1;
    if (page > 2000) break;
  }
  return items;
}

async function fetchPullCommentNodes(context: GitHubContext, node: ConversationNode, perPage: number, maxComments: number): Promise<CommentNode[]> {
  const nodeNumber = node.number;
  if (nodeNumber === undefined) return [];
  const nodes: CommentNode[] = [];
  try {
    const raw = await fetchPagedItems(
      async (page, pageSize) => {
        const { data } = await context.octokit.rest.issues.listComments({
          owner: node.owner,
          repo: node.repo,
          issue_number: nodeNumber,
          per_page: pageSize,
          page,
          sort: "created",
          direction: "desc",
        });
        return data ?? [];
      },
      perPage,
      maxComments
    );
    for (const comment of raw) {
      const parsed = isRecord(comment) ? buildCommentNode("IssueComment", comment) : null;
      if (parsed) nodes.push(parsed);
    }
  } catch (error) {
    context.logger.debug({ err: error, nodeId: node.id }, "Failed to fetch PR issue comments (non-fatal)");
  }

  try {
    const raw = await fetchPagedItems(
      async (page, pageSize) => {
        const { data } = await context.octokit.rest.pulls.listReviewComments({
          owner: node.owner,
          repo: node.repo,
          pull_number: nodeNumber,
          per_page: pageSize,
          page,
          sort: "created",
          direction: "desc",
        });
        return data ?? [];
      },
      perPage,
      maxComments
    );
    for (const comment of raw) {
      const parsed = isRecord(comment) ? buildCommentNode("ReviewComment", comment) : null;
      if (parsed) nodes.push(parsed);
    }
  } catch (error) {
    context.logger.debug({ err: error, nodeId: node.id }, "Failed to fetch PR review comments (non-fatal)");
  }

  try {
    const raw = await fetchPagedItems(
      async (page, pageSize) => {
        const { data } = await context.octokit.rest.pulls.listReviews({
          owner: node.owner,
          repo: node.repo,
          pull_number: nodeNumber,
          per_page: pageSize,
          page,
        });
        return data ?? [];
      },
      perPage,
      maxComments
    );
    for (const review of raw) {
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
  const isUnlimited = isUnlimitedLimit(maxComments);
  const pageLimit = Number.isFinite(maxComments) ? Math.min(maxComments, 100) : 100;
  const perPage = Math.min(100, Math.max(1, pageLimit));
  const rawNodes =
    node.type === "PullRequest"
      ? await fetchPullCommentNodes(context, node, perPage, maxComments)
      : await fetchIssueCommentNodes(context, node, perPage, maxComments);
  const deduped = dedupeCommentNodes(rawNodes);
  const sorted = sortCommentsByDate(deduped);
  if (isUnlimited) {
    return {
      total: sorted.length,
      nodes: sorted,
    };
  }
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

type SimilaritySeedMatch = Readonly<{
  id: string;
  similarity: number;
}>;

async function findSimilarForDocument(config: ReturnType<typeof getVectorDbConfig>, doc: VectorDocument): Promise<SimilaritySeedMatch[]> {
  if (!config) return [];
  const embedding = Array.isArray(doc.embedding) ? doc.embedding : [];
  if (embedding.length === 0) return [];
  const [issueResults, commentResults] = await Promise.all([
    findSimilarIssues(config, {
      currentId: doc.id,
      embedding,
      threshold: DEFAULT_SEMANTIC_THRESHOLD,
      topK: DEFAULT_SEMANTIC_TOP_K,
    }),
    findSimilarComments(config, {
      currentId: doc.id,
      embedding,
      threshold: DEFAULT_SEMANTIC_THRESHOLD,
      topK: DEFAULT_SEMANTIC_TOP_K,
    }),
  ]);
  const combined = [...issueResults, ...commentResults];
  combined.sort((a, b) => b.similarity - a.similarity);
  const seen = new Set<string>();
  const deduped: SimilaritySeedMatch[] = [];
  for (const item of combined) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
    if (deduped.length >= DEFAULT_SEMANTIC_TOP_K) break;
  }
  return deduped;
}

async function buildSimilarityMap(
  config: ReturnType<typeof getVectorDbConfig>,
  seedDocs: VectorDocument[],
  excludeIds: Set<string>
): Promise<Map<string, SimilarityMatchDisplay[]>> {
  if (!config || seedDocs.length === 0) return new Map();

  const seedMatches = new Map<string, SimilaritySeedMatch[]>();
  const matchIds = new Set<string>();
  for (const doc of seedDocs) {
    const matches = await findSimilarForDocument(config, doc);
    const filtered = matches.filter((match) => !excludeIds.has(match.id));
    if (!filtered.length) continue;
    seedMatches.set(doc.id, filtered);
    for (const match of filtered) {
      matchIds.add(match.id);
    }
  }

  if (matchIds.size === 0) return new Map();

  const matchDocs = await fetchVectorDocuments(config, [...matchIds]);
  const matchDocMap = new Map(matchDocs.map((doc) => [doc.id, doc]));
  const out = new Map<string, SimilarityMatchDisplay[]>();
  for (const [seedId, matches] of seedMatches) {
    const display: SimilarityMatchDisplay[] = [];
    for (const match of matches) {
      const doc = matchDocMap.get(match.id);
      if (!doc) continue;
      const node = buildNodeFromVectorDocument(doc) ?? buildCommentNodeFromDocument(doc);
      if (!node) continue;
      display.push({ node, similarity: match.similarity });
    }
    if (display.length > 0) {
      out.set(seedId, display);
    }
  }
  return out;
}

async function buildSimilarityForGraph(
  context: GitHubContext,
  root: ConversationNode,
  linked: ConversationNode[],
  commentNodes: CommentNode[],
  includeSemantic: boolean
): Promise<Map<string, SimilarityMatchDisplay[]>> {
  if (!includeSemantic) return new Map();
  const config = getVectorDbConfig(context.logger);
  if (!config) return new Map();
  const seedIds = new Set<string>([root.id, ...linked.map((node) => node.id), ...commentNodes.map((node) => node.id)]);
  const seedDocs = await fetchVectorDocuments(config, [...seedIds], {
    includeEmbedding: true,
  });
  return buildSimilarityMap(config, seedDocs, seedIds);
}

function noop(): void {}

function createLogger(isVerbose: boolean) {
  return {
    debug: isVerbose ? console.debug.bind(console) : noop,
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
}

function sumTotals<T>(values: T[], pick: (value: T) => number): number {
  return values.reduce((total, value) => total + pick(value), 0);
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
  function logTiming(label: string, startMs: number, detail?: string) {
    if (!options.isVerbose) return;
    const elapsed = Date.now() - startMs;
    const suffix = detail ? ` (${detail})` : "";
    console.log(styleDim(`[timing] ${label}: ${elapsed}ms${suffix}`, isColorEnabled));
  }

  const resolveStart = Date.now();
  const conversation = await resolveConversationKeyForContext(context, logger);
  if (!conversation) {
    console.error("Failed to resolve conversation graph for the URL.");
    Deno.exit(1);
  }
  logTiming("resolve graph", resolveStart, `linked=${conversation.linked.length}`);

  const linked = conversation.linked;
  const kvStart = Date.now();
  const keyNodes = await listConversationNodesForKey(context, conversation.key, options.maxNodes, logger);
  logTiming("load kv nodes", kvStart, `nodes=${keyNodes.length}`);
  const linkedIds = new Set(linked.map((node) => node.id));
  const kvNodes = keyNodes.filter((node) => node.id !== conversation.root.id && !linkedIds.has(node.id));
  const commentTargets = options.includeComments ? [conversation.root, ...linked] : [];
  const commentStart = Date.now();
  const commentMap = options.includeComments ? await fetchCommentsForNodes(context, commentTargets, options.maxComments) : new Map();
  const commentNodes = options.includeComments ? [...commentMap.values()].flatMap((list) => list.nodes) : [];
  if (options.includeComments) {
    const totals = [...commentMap.values()];
    const shown = sumTotals(totals, (list) => list.nodes.length);
    const total = sumTotals(totals, (list) => list.total);
    logTiming("fetch comments", commentStart, `threads=${commentTargets.length} comments=${shown}/${total}`);
  }
  const semanticStart = Date.now();
  const similarityById = await buildSimilarityForGraph(context, conversation.root, linked, commentNodes, options.includeSemantic);
  if (options.includeSemantic) {
    const matches = sumTotals([...similarityById.values()], (list) => list.length);
    logTiming("semantic lookup", semanticStart, `matches=${matches}`);
  }

  console.log(styleHeader("Conversation Graph", isColorEnabled));
  console.log(`${styleLabel("Root:", isColorEnabled)} ${styleValue(formatNode(conversation.root), isColorEnabled)}`);
  if (conversation.root.url) {
    console.log(`  ${styleDim(conversation.root.url, isColorEnabled)}`);
  }

  const rootComments = commentMap.get(conversation.root.id);
  if (rootComments && rootComments.nodes.length > 0) {
    const countLabel = rootComments.total > rootComments.nodes.length ? `${rootComments.nodes.length}/${rootComments.total}` : rootComments.total;
    const commentsIndent = renderSection("Comments", {
      count: countLabel,
      isLast: false,
      isColorEnabled,
    });
    renderCommentList(rootComments.nodes, isColorEnabled, commentsIndent, similarityById);
  }

  const rootMatches = similarityById.get(conversation.root.id) ?? [];
  if (rootMatches.length > 0) {
    const similarIndent = renderSection("Similar", {
      count: rootMatches.length,
      isLast: false,
      isColorEnabled,
    });
    renderSimilarityList(rootMatches, isColorEnabled, similarIndent);
  }

  const linksIndent = renderSection("Links", {
    count: linked.length,
    isLast: false,
    isColorEnabled,
  });
  renderNodeListWithComments(linked, commentMap, isColorEnabled, similarityById, { indent: linksIndent, showHeader: false });

  const memoryIndent = renderSection("Memory (merged history)", {
    count: kvNodes.length,
    isLast: true,
    isColorEnabled,
  });
  if (kvNodes.length > 0) {
    renderNodeList("", kvNodes, isColorEnabled, {
      indent: memoryIndent,
      showHeader: false,
    });
  } else {
    console.log(`${memoryIndent}\`-- ${styleDim("(none yet; populated when this key merges related threads)", isColorEnabled)}`);
  }

  if (options.includeContext) {
    const contextStart = Date.now();
    const contextMaxItems = isUnlimitedLimit(options.contextMaxItems) ? DEFAULT_CONTEXT_MAX_ITEMS : options.contextMaxItems;
    const contextMaxComments = isUnlimitedLimit(options.contextMaxComments) ? DEFAULT_CONTEXT_MAX_COMMENTS : options.contextMaxComments;
    const contextMaxChars = isUnlimitedLimit(options.contextMaxChars) ? DEFAULT_CONTEXT_MAX_CHARS : options.contextMaxChars;
    const contextMaxCommentChars = isUnlimitedLimit(options.contextMaxCommentChars) ? DEFAULT_CONTEXT_MAX_COMMENT_CHARS : options.contextMaxCommentChars;
    const conversationContext = await buildConversationContext({
      context,
      conversation,
      maxItems: contextMaxItems,
      maxChars: contextMaxChars,
      includeSemantic: options.includeSemantic,
      includeComments: options.includeComments,
      maxComments: contextMaxComments,
      maxCommentChars: contextMaxCommentChars,
      useSelector: false,
    });
    logTiming("build conversationContext", contextStart);
    console.log("");
    console.log(styleHeader("Conversation Context Preview", isColorEnabled));
    if (conversationContext) {
      console.log("Conversation context (linked/semantic, untrusted):");
      console.log(conversationContext);
    } else {
      console.log(styleDim("(conversationContext is empty)", isColorEnabled));
    }
  }
}

if (import.meta.main) {
  void main();
}
