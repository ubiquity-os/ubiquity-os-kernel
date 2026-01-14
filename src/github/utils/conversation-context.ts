import { GitHubContext } from "../github-context.ts";
import { ConversationNode, ConversationKeyResult, listConversationNodesForKey } from "./conversation-graph.ts";
import { callUbqAiRouter } from "./ai-router.ts";
import type { LoggerLike } from "./kv-client.ts";
import {
  fetchVectorDocument,
  fetchVectorDocuments,
  fetchVectorDocumentsByParentId,
  findSimilarComments,
  findSimilarIssues,
  getVectorDbConfig,
  VectorDocument,
} from "./vector-db.ts";

const DEFAULT_MAX_ITEMS = 10;
const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_MAX_COMMENTS = 8;
const DEFAULT_MAX_COMMENT_CHARS = 256;
const DEFAULT_SIMILARITY_THRESHOLD = 0.8;
const DEFAULT_SIMILARITY_TOP_K = 5;
const DEFAULT_AUTHOR_BOOST = 0.07;
const DEFAULT_OWNER_BOOST = 0.04;
const DEFAULT_RECENCY_BOOST = 0.06;
const DEFAULT_SELECTOR_BATCH_SIZE = 20;
const DEFAULT_SELECTOR_MAX_CANDIDATES = 120;
const DEFAULT_SELECTOR_MAX_BODY_CHARS = 900;
const DEFAULT_SELECTOR_MAX_COMMENT_CHARS = 280;
const DEFAULT_SELECTOR_MAX_COMMENTS = 6;
const DEFAULT_SELECTOR_TIMEOUT_MS = 20_000;
const DEFAULT_GITHUB_CONCURRENCY = 4;
const DEFAULT_VECTOR_CONCURRENCY = 6;
const COMMENT_DOC_TYPES = ["issue_comment", "review_comment", "pull_request_review"];

function clampText(value: string, maxChars: number): string {
  const text = value.trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

async function mapWithConcurrency<TItem, TResult>(items: TItem[], limit: number, handler: (item: TItem) => Promise<TResult>): Promise<TResult[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.trunc(limit));
  const results: TResult[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await handler(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

function formatNodeLine(node: ConversationNode): string {
  const typeLabel = node.type === "Issue" ? "Issue" : "PR";
  const repoLabel = node.owner && node.repo ? `${node.owner}/${node.repo}` : "unknown";
  const numberLabel = typeof node.number === "number" ? `#${node.number}` : "";
  const title = node.title ? ` - ${node.title}` : "";
  return `- [${typeLabel}] ${repoLabel}${numberLabel}${title}`;
}

type CommentKind = "IssueComment" | "ReviewComment" | "Review";

type CommentEntry = Readonly<{
  id: string;
  kind: CommentKind;
  author: string;
  createdAt: string;
  url: string;
  body: string;
}>;

type DocumentKind = "Issue" | "PullRequest" | "IssueComment" | "ReviewComment" | "PullRequestReview";

type SelectionCandidate = Readonly<{
  id: string;
  kind: DocumentKind;
  source: "graph" | "semantic";
  owner: string;
  repo: string;
  number?: number;
  title?: string;
  url: string;
  createdAt?: string;
  body?: string;
  comments?: Array<{ author: string; date: string; body: string }>;
}>;

function indentBlock(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function normalizeMarkdown(markdown: string | null): string {
  if (!markdown) return "";
  return markdown.trim();
}

function formatDateLabel(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toISOString().slice(0, 10);
}

function getCommentKindLabel(kind: CommentKind): string {
  if (kind === "IssueComment") return "Issue Comment";
  if (kind === "ReviewComment") return "Review Comment";
  return "Review";
}

function formatCommentLine(comment: CommentEntry): string {
  const kindLabel = getCommentKindLabel(comment.kind);
  const author = comment.author ? `@${comment.author}` : "unknown";
  const date = formatDateLabel(comment.createdAt);
  const meta = [author, date].filter(Boolean).join(" ");
  return `- [${kindLabel}] ${meta}`.trim();
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function parseSelectorResponse(raw: string): { includeIds: string[] } | null {
  const trimmed = raw.trim();
  const direct = (() => {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  })();
  if (direct && typeof direct === "object" && direct !== null) {
    const includeIdsRaw = (direct as { includeIds?: unknown }).includeIds;
    const includeIds = Array.isArray(includeIdsRaw) ? includeIdsRaw : [];
    const filtered = includeIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    return { includeIds: filtered };
  }

  const snippet = extractJsonObject(trimmed);
  if (!snippet) return null;
  try {
    const parsed = JSON.parse(snippet) as { includeIds?: unknown };
    const includeIds = Array.isArray(parsed?.includeIds) ? parsed.includeIds : [];
    const filtered = includeIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    return { includeIds: filtered };
  } catch {
    return null;
  }
}

function dedupeNodes(nodes: ConversationNode[]): ConversationNode[] {
  const seen = new Set<string>();
  const out: ConversationNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function dedupeComments(nodes: CommentEntry[]): CommentEntry[] {
  const seen = new Set<string>();
  const out: CommentEntry[] = [];
  for (const node of nodes) {
    const key = `${node.kind}:${node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node);
  }
  return out;
}

function sortCommentsByDate(nodes: CommentEntry[]): CommentEntry[] {
  return [...nodes].sort((a, b) => {
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    const aScore = Number.isFinite(aTime) ? aTime : 0;
    const bScore = Number.isFinite(bTime) ? bTime : 0;
    return bScore - aScore;
  });
}

function collectParticipantIds(context: GitHubContext): Set<number> {
  const ids = new Set<number>();
  const payload = context.payload as Record<string, unknown>;
  const issue = isRecord(payload.issue) ? payload.issue : null;
  const pullRequest = isRecord(payload.pull_request) ? payload.pull_request : null;
  const comment = isRecord(payload.comment) ? payload.comment : null;
  const issueUser = isRecord(issue?.user) ? issue.user : null;
  const prUser = isRecord(pullRequest?.user) ? pullRequest.user : null;
  const commentUser = isRecord(comment?.user) ? comment.user : null;
  const issueUserId = typeof issueUser?.id === "number" ? issueUser.id : null;
  const prUserId = typeof prUser?.id === "number" ? prUser.id : null;
  const commentUserId = typeof commentUser?.id === "number" ? commentUser.id : null;
  for (const id of [issueUserId, prUserId, commentUserId]) {
    if (typeof id === "number" && Number.isFinite(id)) ids.add(Math.trunc(id));
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildCommentEntry(kind: CommentKind, payload: Record<string, unknown>): CommentEntry | null {
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
  const timestamp = createdAt || submittedAt;
  let url = "";
  if (typeof payload.html_url === "string") {
    url = payload.html_url;
  } else if (typeof payload.url === "string") {
    url = payload.url;
  }
  const user = isRecord(payload.user) ? payload.user : null;
  const author = typeof user?.login === "string" ? user.login.trim() : "";
  const rawBody = typeof payload.body === "string" ? payload.body : "";
  if (kind === "Review" && !rawBody.trim()) return null;
  if (!id || !url || !timestamp) return null;
  return {
    id,
    kind,
    createdAt: timestamp,
    url,
    author,
    body: rawBody,
  };
}

function getRepositoryOwner(context: GitHubContext): string {
  const payload = context.payload as Record<string, unknown>;
  const repository = isRecord(payload.repository) ? payload.repository : null;
  const owner = isRecord(repository?.owner) ? repository?.owner : null;
  return typeof owner?.login === "string" ? owner.login.trim().toLowerCase() : "";
}

async function fetchPagedItems<T>(fetchPage: (page: number, perPage: number) => Promise<T[]>, perPage: number, maxItems: number): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  while (items.length < maxItems) {
    const batch = await fetchPage(page, perPage);
    if (batch.length === 0) break;
    items.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
    if (page > 2000) break;
  }
  return items.slice(0, maxItems);
}

async function fetchIssueComments(context: GitHubContext, node: ConversationNode, maxComments: number): Promise<CommentEntry[]> {
  const nodeNumber = node.number;
  if (nodeNumber === undefined || maxComments <= 0) return [];
  try {
    const perPage = Math.min(100, Math.max(1, maxComments));
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
    const entries: CommentEntry[] = [];
    for (const comment of raw) {
      const parsed = isRecord(comment) ? buildCommentEntry("IssueComment", comment) : null;
      if (parsed) entries.push(parsed);
    }
    return entries;
  } catch (error) {
    context.logger.debug({ err: error, nodeId: node.id }, "Failed to fetch issue comments for conversation context");
    return [];
  }
}

async function fetchPullComments(context: GitHubContext, node: ConversationNode, maxComments: number): Promise<CommentEntry[]> {
  const nodeNumber = node.number;
  if (nodeNumber === undefined || maxComments <= 0) return [];
  const perPage = Math.min(100, Math.max(1, maxComments));
  const entries: CommentEntry[] = [];
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
      const parsed = isRecord(comment) ? buildCommentEntry("IssueComment", comment) : null;
      if (parsed) entries.push(parsed);
    }
  } catch (error) {
    context.logger.debug({ err: error, nodeId: node.id }, "Failed to fetch PR issue comments for conversation context");
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
      const parsed = isRecord(comment) ? buildCommentEntry("ReviewComment", comment) : null;
      if (parsed) entries.push(parsed);
    }
  } catch (error) {
    context.logger.debug({ err: error, nodeId: node.id }, "Failed to fetch PR review comments for conversation context");
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
      const parsed = isRecord(review) ? buildCommentEntry("Review", review) : null;
      if (parsed) entries.push(parsed);
    }
  } catch (error) {
    context.logger.debug({ err: error, nodeId: node.id }, "Failed to fetch PR reviews for conversation context");
  }

  return entries;
}

async function fetchCommentsForNode(context: GitHubContext, node: ConversationNode, maxComments: number): Promise<CommentEntry[]> {
  if (maxComments <= 0) return [];
  const raw = node.type === "PullRequest" ? await fetchPullComments(context, node, maxComments) : await fetchIssueComments(context, node, maxComments);
  const deduped = dedupeComments(raw);
  const sorted = sortCommentsByDate(deduped);
  return sorted.slice(0, maxComments);
}

async function fetchCommentsForNodes(context: GitHubContext, nodes: ConversationNode[], maxComments: number): Promise<Map<string, CommentEntry[]>> {
  const map = new Map<string, CommentEntry[]>();
  const entries = await mapWithConcurrency(nodes, DEFAULT_GITHUB_CONCURRENCY, async (node) => {
    const comments = await fetchCommentsForNode(context, node, maxComments);
    return { id: node.id, comments };
  });
  for (const entry of entries) {
    map.set(entry.id, entry.comments);
  }
  return map;
}

async function fetchNodeBodyMarkdown(context: GitHubContext, node: ConversationNode): Promise<string> {
  const nodeNumber = node.number;
  if (nodeNumber === undefined) return "";
  try {
    if (node.type === "PullRequest") {
      const { data } = await context.octokit.rest.pulls.get({
        owner: node.owner,
        repo: node.repo,
        pull_number: nodeNumber,
      });
      return typeof data.body === "string" ? data.body : "";
    }
    const { data } = await context.octokit.rest.issues.get({
      owner: node.owner,
      repo: node.repo,
      issue_number: nodeNumber,
    });
    return typeof data.body === "string" ? data.body : "";
  } catch (error) {
    context.logger.debug({ err: error, nodeId: node.id }, "Failed to fetch node body for conversation context");
    return "";
  }
}

function buildNodeFromDocument(doc: VectorDocument): ConversationNode | null {
  const payload = isRecord(doc.payload) ? (doc.payload as Record<string, unknown>) : null;
  if (!payload) return null;
  const repository = isRecord(payload.repository) ? payload.repository : null;
  const ownerObj = isRecord(repository?.owner) ? repository.owner : null;
  const owner = typeof ownerObj?.login === "string" ? ownerObj.login.trim() : "";
  const repo = typeof repository?.name === "string" ? repository.name : "";
  const issue = isRecord(payload.issue) ? payload.issue : null;
  const pullRequest = isRecord(payload.pull_request) ? payload.pull_request : null;
  const isIssue = doc.docType === "issue";
  const source = isIssue ? issue : pullRequest;
  if (!source) return null;
  const createdAt = typeof source.created_at === "string" ? source.created_at : "";
  let url = "";
  if (typeof source.html_url === "string") {
    url = source.html_url;
  } else if (typeof source.url === "string") {
    url = source.url;
  }
  const number = typeof source.number === "number" ? source.number : undefined;
  const title = typeof source.title === "string" ? source.title : undefined;
  const type = isIssue ? "Issue" : "PullRequest";
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

type DocumentDescriptor = Readonly<{
  id: string;
  kind: DocumentKind;
  owner: string;
  repo: string;
  number?: number;
  title?: string;
  url: string;
  author?: string;
  createdAt?: string;
}>;

function buildDescriptorFromDocument(doc: VectorDocument): DocumentDescriptor | null {
  const payload = isRecord(doc.payload) ? (doc.payload as Record<string, unknown>) : null;
  if (!payload) return null;
  const repository = isRecord(payload.repository) ? payload.repository : null;
  const ownerObj = isRecord(repository?.owner) ? repository.owner : null;
  const owner = typeof ownerObj?.login === "string" ? ownerObj.login.trim() : "";
  const repo = typeof repository?.name === "string" ? repository.name : "";
  if (!owner || !repo) return null;

  if (doc.docType === "issue" || doc.docType === "pull_request") {
    const node = buildNodeFromDocument(doc);
    if (!node) return null;
    return {
      id: doc.id,
      kind: node.type === "Issue" ? "Issue" : "PullRequest",
      owner: node.owner,
      repo: node.repo,
      number: node.number,
      title: node.title,
      url: node.url,
      createdAt: node.createdAt,
    };
  }

  if (!COMMENT_DOC_TYPES.includes(doc.docType)) return null;
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
  const issue = isRecord(payload.issue) ? payload.issue : null;
  const pullRequest = isRecord(payload.pull_request) ? payload.pull_request : null;
  let number: number | undefined;
  if (typeof issue?.number === "number") {
    number = issue.number;
  } else if (typeof pullRequest?.number === "number") {
    number = pullRequest.number;
  }
  if (!url || !timestamp) return null;
  let kind: DocumentDescriptor["kind"] = "PullRequestReview";
  if (doc.docType === "issue_comment") {
    kind = "IssueComment";
  } else if (doc.docType === "review_comment") {
    kind = "ReviewComment";
  }
  return {
    id: doc.id,
    kind,
    owner,
    repo,
    number,
    url,
    author: author || undefined,
    createdAt: timestamp,
  };
}

function formatDescriptorLine(descriptor: DocumentDescriptor, options: Readonly<{ similarity?: number }> = {}): string {
  let typeLabel = "Review";
  if (descriptor.kind === "Issue") {
    typeLabel = "Issue";
  } else if (descriptor.kind === "PullRequest") {
    typeLabel = "PR";
  } else if (descriptor.kind === "IssueComment") {
    typeLabel = "Issue Comment";
  } else if (descriptor.kind === "ReviewComment") {
    typeLabel = "Review Comment";
  }
  const repoLabel = descriptor.owner && descriptor.repo ? `${descriptor.owner}/${descriptor.repo}` : "unknown";
  const numberLabel = typeof descriptor.number === "number" ? `#${descriptor.number}` : "";
  const title = descriptor.title ? ` - ${descriptor.title}` : "";
  const author = descriptor.author ? ` @${descriptor.author}` : "";
  const score = typeof options.similarity === "number" ? ` (sim ${options.similarity.toFixed(2)})` : "";
  return `- [${typeLabel}] ${repoLabel}${numberLabel}${title}${author}${score}`;
}

function formatSeedLabel(doc: VectorDocument): string {
  const descriptor = buildDescriptorFromDocument(doc);
  if (!descriptor) return doc.id;
  return formatDescriptorLine(descriptor).replace(/^- /, "");
}

function formatMatchedBy(labels: string[]): string {
  if (labels.length === 0) return "";
  const trimmed = labels.slice(0, 3);
  const extra = labels.length - trimmed.length;
  const suffix = extra > 0 ? ` +${extra} more` : "";
  return `${trimmed.join("; ")}${suffix}`;
}

function getDocumentTimestamp(doc: VectorDocument): number | null {
  const payload = isRecord(doc.payload) ? (doc.payload as Record<string, unknown>) : null;
  if (!payload) return null;
  const issue = isRecord(payload.issue) ? payload.issue : null;
  const pullRequest = isRecord(payload.pull_request) ? payload.pull_request : null;
  const comment = isRecord(payload.comment) ? payload.comment : null;
  const review = isRecord(payload.review) ? payload.review : null;
  let source: Record<string, unknown> | null = null;
  if (doc.docType === "issue") {
    source = issue;
  } else if (doc.docType === "pull_request") {
    source = pullRequest;
  } else if (COMMENT_DOC_TYPES.includes(doc.docType)) {
    source = comment ?? review;
  }
  if (!source) return null;
  const updatedAt = typeof source.updated_at === "string" ? source.updated_at : "";
  const createdAt = typeof source.created_at === "string" ? source.created_at : "";
  const submittedAt = typeof source.submitted_at === "string" ? source.submitted_at : "";
  const parsed = Date.parse(updatedAt || submittedAt || createdAt);
  return Number.isFinite(parsed) ? parsed : null;
}

async function findSimilarForDocument(
  config: ReturnType<typeof getVectorDbConfig>,
  doc: VectorDocument,
  logger?: LoggerLike
): Promise<{ id: string; similarity: number }[]> {
  if (!config) return [];
  const embedding = Array.isArray(doc.embedding) ? doc.embedding : [];
  if (embedding.length === 0) return [];
  const [issueResults, commentResults] = await Promise.all([
    findSimilarIssues(
      config,
      {
        currentId: doc.id,
        embedding,
        threshold: DEFAULT_SIMILARITY_THRESHOLD,
        topK: DEFAULT_SIMILARITY_TOP_K,
      },
      logger
    ),
    findSimilarComments(
      config,
      {
        currentId: doc.id,
        embedding,
        threshold: DEFAULT_SIMILARITY_THRESHOLD,
        topK: DEFAULT_SIMILARITY_TOP_K,
      },
      logger
    ),
  ]);
  const combined = [...issueResults, ...commentResults];
  combined.sort((a, b) => b.similarity - a.similarity);
  const seen = new Set<string>();
  const deduped: { id: string; similarity: number }[] = [];
  for (const item of combined) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
    if (deduped.length >= DEFAULT_SIMILARITY_TOP_K) break;
  }
  return deduped;
}

function buildSelectorPrompt(maxSelections: number): string {
  return `
You are a context selector for a conversation graph.

Return ONLY JSON with this shape:
{ "includeIds": ["..."] }

Rules:
- Use ONLY IDs from the provided candidates list.
- Choose the minimal set required to answer the query.
- Return at most ${maxSelections} IDs.
- If nothing beyond the root is needed, return an empty array.
- Do not include anything irrelevant.
`.trim();
}

function buildCandidateComments(comments: CommentEntry[], maxComments: number, maxChars: number): Array<{ author: string; date: string; body: string }> {
  const entries: Array<{ author: string; date: string; body: string }> = [];
  for (const comment of comments.slice(0, maxComments)) {
    const body = clampText(normalizeMarkdown(comment.body), maxChars);
    if (!body) continue;
    entries.push({
      author: comment.author || "unknown",
      date: formatDateLabel(comment.createdAt),
      body,
    });
  }
  return entries;
}

function buildSelectorCandidateFromNode(
  node: ConversationNode,
  body: string,
  comments: CommentEntry[],
  source: SelectionCandidate["source"]
): SelectionCandidate {
  return {
    id: node.id,
    kind: node.type,
    source,
    owner: node.owner,
    repo: node.repo,
    number: node.number,
    title: node.title,
    url: node.url,
    createdAt: node.createdAt,
    body: clampText(body, DEFAULT_SELECTOR_MAX_BODY_CHARS),
    comments: buildCandidateComments(comments, DEFAULT_SELECTOR_MAX_COMMENTS, DEFAULT_SELECTOR_MAX_COMMENT_CHARS),
  };
}

function buildSelectorCandidateFromSemantic(entry: { doc: VectorDocument; descriptor: DocumentDescriptor }): SelectionCandidate | null {
  const { descriptor, doc } = entry;
  if (!descriptor.url) return null;
  return {
    id: doc.id,
    kind: descriptor.kind,
    source: "semantic",
    owner: descriptor.owner,
    repo: descriptor.repo,
    number: descriptor.number,
    title: descriptor.title,
    url: descriptor.url,
    createdAt: descriptor.createdAt,
    body: clampText(normalizeMarkdown(doc.markdown ?? ""), DEFAULT_SELECTOR_MAX_BODY_CHARS),
    comments: [],
  };
}

function chunkArray<T>(values: T[], size: number): T[][] {
  if (size <= 0) return [values];
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

async function selectConversationCandidates(
  params: Readonly<{
    context: GitHubContext;
    query: string;
    root: SelectionCandidate;
    candidates: SelectionCandidate[];
    maxSelections: number;
  }>
): Promise<Set<string> | null> {
  const query = params.query.trim();
  if (!query) return null;
  if (!params.context?.eventHandler) return null;
  const payload = params.context.payload as Record<string, unknown>;
  const installation = (payload.installation as { id?: number } | undefined) ?? null;
  if (!installation?.id) return null;

  const limitedCandidates = params.candidates.slice(0, DEFAULT_SELECTOR_MAX_CANDIDATES);
  if (limitedCandidates.length === 0) {
    return new Set([params.root.id]);
  }

  const maxSelections = Math.max(1, Math.trunc(params.maxSelections));
  const prompt = buildSelectorPrompt(maxSelections);
  const selections: string[] = [];
  const seen = new Set<string>();
  const batches = chunkArray(limitedCandidates, DEFAULT_SELECTOR_BATCH_SIZE);
  for (const batch of batches) {
    const input = {
      query,
      root: {
        id: params.root.id,
        kind: params.root.kind,
        repo: `${params.root.owner}/${params.root.repo}`,
        number: params.root.number,
        title: params.root.title,
        url: params.root.url,
        body: params.root.body ?? "",
        comments: params.root.comments ?? [],
      },
      candidates: batch.map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        repo: `${candidate.owner}/${candidate.repo}`,
        number: candidate.number,
        title: candidate.title,
        url: candidate.url,
        source: candidate.source,
        body: candidate.body ?? "",
        comments: candidate.comments ?? [],
      })),
    };

    try {
      const raw = await callUbqAiRouter(params.context, prompt, input, { timeoutMs: DEFAULT_SELECTOR_TIMEOUT_MS });
      const parsed = parseSelectorResponse(raw);
      if (!parsed) {
        params.context.logger.debug("Selector response did not parse");
        continue;
      }
      for (const id of parsed.includeIds) {
        const trimmed = id.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        selections.push(trimmed);
      }
    } catch (error) {
      params.context.logger.warn({ err: error }, "Selector call failed (non-fatal)");
    }
  }

  const limited = selections.slice(0, maxSelections);
  return new Set<string>([params.root.id, ...limited]);
}

export async function buildConversationContext(
  params: Readonly<{
    context: GitHubContext;
    conversation: ConversationKeyResult;
    maxItems?: number;
    maxChars?: number;
    includeSemantic?: boolean;
    includeComments?: boolean;
    maxComments?: number;
    maxCommentChars?: number;
    query?: string;
    useSelector?: boolean;
  }>
): Promise<string> {
  const maxItems = typeof params.maxItems === "number" && Number.isFinite(params.maxItems) ? Math.max(1, Math.trunc(params.maxItems)) : DEFAULT_MAX_ITEMS;
  const maxChars = typeof params.maxChars === "number" && Number.isFinite(params.maxChars) ? Math.max(200, Math.trunc(params.maxChars)) : DEFAULT_MAX_CHARS;
  const includeSemantic = params.includeSemantic !== false;
  const maxComments =
    typeof params.maxComments === "number" && Number.isFinite(params.maxComments) ? Math.max(0, Math.trunc(params.maxComments)) : DEFAULT_MAX_COMMENTS;
  const maxCommentChars =
    typeof params.maxCommentChars === "number" && Number.isFinite(params.maxCommentChars)
      ? Math.max(40, Math.trunc(params.maxCommentChars))
      : DEFAULT_MAX_COMMENT_CHARS;
  const includeComments = params.includeComments !== false && maxComments > 0;

  const keyNodes = await listConversationNodesForKey(params.context, params.conversation.key, maxItems * 2, params.context.logger);
  const explicitNodes = dedupeNodes([...params.conversation.linked, ...keyNodes]).filter((node) => node.id !== params.conversation.root.id);
  const threadNodes = [params.conversation.root, ...explicitNodes];

  const commentMap = includeComments ? await fetchCommentsForNodes(params.context, threadNodes, maxComments) : new Map<string, CommentEntry[]>();

  const config = includeSemantic ? getVectorDbConfig(params.context.logger) : null;
  const docMap = new Map<string, VectorDocument>();
  const graphDocIds = new Set<string>([params.conversation.root.id]);
  const seedParentMap = new Map<string, string>();
  const semanticByParent = new Map<string, Array<{ doc: VectorDocument; descriptor: DocumentDescriptor; similarity: number; matchedBy: string }>>();
  if (config) {
    const explicitDocs = await fetchVectorDocuments(
      config,
      explicitNodes.map((node) => node.id),
      { includeEmbedding: true },
      params.context.logger
    );
    for (const doc of explicitDocs) {
      docMap.set(doc.id, doc);
      graphDocIds.add(doc.id);
      seedParentMap.set(doc.id, doc.id);
    }
  }

  if (config) {
    const seedDocs: VectorDocument[] = [];
    const rootDoc = await fetchVectorDocument(config, params.conversation.root.id, params.context.logger);
    if (rootDoc) {
      docMap.set(rootDoc.id, rootDoc);
      graphDocIds.add(rootDoc.id);
      seedParentMap.set(rootDoc.id, params.conversation.root.id);
      if (rootDoc.embedding && rootDoc.embedding.length > 0) {
        seedDocs.push(rootDoc);
      }
    }

    for (const doc of docMap.values()) {
      if (doc.embedding && doc.embedding.length > 0) {
        seedDocs.push(doc);
      }
    }

    const commentSeedLimit = Math.max(DEFAULT_MAX_COMMENTS, maxComments);
    const commentDocsByNode = await mapWithConcurrency(threadNodes, DEFAULT_VECTOR_CONCURRENCY, async (node) => {
      const comments = await fetchVectorDocumentsByParentId(
        config,
        node.id,
        {
          includeEmbedding: true,
          maxPerParent: commentSeedLimit,
          docTypes: COMMENT_DOC_TYPES,
        },
        params.context.logger
      );
      return { nodeId: node.id, comments };
    });
    for (const entry of commentDocsByNode) {
      for (const doc of entry.comments) {
        docMap.set(doc.id, doc);
        graphDocIds.add(doc.id);
        seedParentMap.set(doc.id, entry.nodeId);
        if (doc.embedding && doc.embedding.length > 0) {
          seedDocs.push(doc);
        }
      }
    }

    const seedMap = new Map<string, VectorDocument>();
    for (const doc of seedDocs) {
      if (!seedMap.has(doc.id)) seedMap.set(doc.id, doc);
    }

    const similarityById = new Map<string, { similarity: number; sources: Set<string> }>();
    const seedDocsList = [...seedMap.values()];
    const similarityResults = await mapWithConcurrency(seedDocsList, DEFAULT_VECTOR_CONCURRENCY, async (doc) => {
      const matches = await findSimilarForDocument(config, doc, params.context.logger);
      return { docId: doc.id, matches };
    });
    for (const result of similarityResults) {
      for (const match of result.matches) {
        if (graphDocIds.has(match.id)) continue;
        const existing = similarityById.get(match.id);
        if (existing) {
          existing.sources.add(result.docId);
          if (match.similarity > existing.similarity) existing.similarity = match.similarity;
        } else {
          similarityById.set(match.id, { similarity: match.similarity, sources: new Set([result.docId]) });
        }
      }
    }

    const candidateIds = [...similarityById.keys()];
    if (candidateIds.length > 0) {
      const candidateDocs = await fetchVectorDocuments(config, candidateIds, undefined, params.context.logger);
      for (const doc of candidateDocs) {
        docMap.set(doc.id, doc);
      }

      const candidates = candidateDocs
        .map((doc) => {
          const descriptor = buildDescriptorFromDocument(doc);
          const meta = similarityById.get(doc.id);
          if (!descriptor || !meta) return null;
          const timestampMs = getDocumentTimestamp(doc);
          return { descriptor, doc, similarity: meta.similarity, sources: meta.sources, timestampMs };
        })
        .filter((row): row is { descriptor: DocumentDescriptor; doc: VectorDocument; similarity: number; sources: Set<string>; timestampMs: number | null } =>
          Boolean(row)
        );

      const participants = collectParticipantIds(params.context);
      const repoOwner = getRepositoryOwner(params.context);
      const timeValues = candidates.map((row) => row.timestampMs).filter((value): value is number => typeof value === "number");
      const minTime = timeValues.length ? Math.min(...timeValues) : null;
      const maxTime = timeValues.length ? Math.max(...timeValues) : null;
      const timeRange = minTime !== null && maxTime !== null ? maxTime - minTime : 0;

      candidates.sort((a, b) => {
        const authorBoostA = a.doc.authorId !== null && participants.has(a.doc.authorId) ? DEFAULT_AUTHOR_BOOST : 0;
        const authorBoostB = b.doc.authorId !== null && participants.has(b.doc.authorId) ? DEFAULT_AUTHOR_BOOST : 0;
        const ownerBoostA = repoOwner && a.descriptor.owner.toLowerCase() === repoOwner ? DEFAULT_OWNER_BOOST : 0;
        const ownerBoostB = repoOwner && b.descriptor.owner.toLowerCase() === repoOwner ? DEFAULT_OWNER_BOOST : 0;
        const recencyA = timeRange > 0 && typeof a.timestampMs === "number" && minTime !== null ? (a.timestampMs - minTime) / timeRange : 1;
        const recencyB = timeRange > 0 && typeof b.timestampMs === "number" && minTime !== null ? (b.timestampMs - minTime) / timeRange : 1;
        const recencyBoostA = timeRange > 0 ? recencyA * DEFAULT_RECENCY_BOOST : 0;
        const recencyBoostB = timeRange > 0 ? recencyB * DEFAULT_RECENCY_BOOST : 0;
        const scoreA = a.similarity + authorBoostA + ownerBoostA + recencyBoostA;
        const scoreB = b.similarity + authorBoostB + ownerBoostB + recencyBoostB;
        return scoreB - scoreA;
      });

      const seenByParent = new Map<string, Set<string>>();
      for (const row of candidates) {
        const meta = similarityById.get(row.doc.id);
        if (!meta) continue;
        const sourceLabels = [...meta.sources]
          .map((id) => seedMap.get(id))
          .filter((seed): seed is VectorDocument => Boolean(seed))
          .map((seed) => formatSeedLabel(seed));
        const matchedBy = formatMatchedBy(sourceLabels);
        const entry = { doc: row.doc, descriptor: row.descriptor, similarity: row.similarity, matchedBy };
        const parentIds = new Set<string>();
        for (const sourceId of meta.sources) {
          const parentId = seedParentMap.get(sourceId);
          if (parentId) parentIds.add(parentId);
        }
        for (const parentId of parentIds) {
          const seen = seenByParent.get(parentId) ?? new Set<string>();
          if (seen.has(row.doc.id)) continue;
          seen.add(row.doc.id);
          seenByParent.set(parentId, seen);
          const list = semanticByParent.get(parentId) ?? [];
          list.push(entry);
          semanticByParent.set(parentId, list);
        }
      }
    }
  }

  const nodeBodyMap = new Map<string, string>();
  const bodyEntries = await mapWithConcurrency(threadNodes, DEFAULT_GITHUB_CONCURRENCY, async (node) => {
    const existing = normalizeMarkdown(docMap.get(node.id)?.markdown ?? null);
    if (existing) {
      return { id: node.id, body: existing };
    }
    const fetched = normalizeMarkdown(await fetchNodeBodyMarkdown(params.context, node));
    return { id: node.id, body: fetched };
  });
  for (const entry of bodyEntries) {
    nodeBodyMap.set(entry.id, entry.body);
  }

  const query = typeof params.query === "string" ? params.query.trim() : "";
  const useSelector = Boolean(query) && params.useSelector !== false;
  let selectionIds: Set<string> | null = null;
  if (useSelector) {
    const rootComments = commentMap.get(params.conversation.root.id) ?? [];
    const rootCandidate = buildSelectorCandidateFromNode(params.conversation.root, nodeBodyMap.get(params.conversation.root.id) ?? "", rootComments, "graph");
    const candidateById = new Map<string, SelectionCandidate>();
    for (const node of threadNodes) {
      if (node.id === params.conversation.root.id) continue;
      const candidate = buildSelectorCandidateFromNode(node, nodeBodyMap.get(node.id) ?? "", commentMap.get(node.id) ?? [], "graph");
      candidateById.set(candidate.id, candidate);
    }
    for (const entries of semanticByParent.values()) {
      for (const entry of entries) {
        const candidate = buildSelectorCandidateFromSemantic(entry);
        if (!candidate || candidate.id === params.conversation.root.id) continue;
        if (!candidateById.has(candidate.id)) candidateById.set(candidate.id, candidate);
      }
    }
    selectionIds = await selectConversationCandidates({
      context: params.context,
      query,
      root: rootCandidate,
      candidates: [...candidateById.values()],
      maxSelections: maxItems,
    });
  }

  let filteredExplicitNodes = explicitNodes;
  let filteredSemanticByParent = semanticByParent;
  if (selectionIds && selectionIds.size > 0) {
    filteredSemanticByParent = new Map<string, Array<{ doc: VectorDocument; descriptor: DocumentDescriptor; similarity: number; matchedBy: string }>>();
    for (const [parentId, entries] of semanticByParent.entries()) {
      const filtered = entries.filter((entry) => selectionIds?.has(entry.doc.id));
      if (filtered.length > 0) filteredSemanticByParent.set(parentId, filtered);
    }
    filteredExplicitNodes = explicitNodes.filter((node) => selectionIds?.has(node.id) || filteredSemanticByParent.has(node.id));
  }

  const lines: string[] = [];
  const rootMarkdown = nodeBodyMap.get(params.conversation.root.id) ?? "";
  const rootComments = commentMap.get(params.conversation.root.id) ?? [];
  const rootSemantic = filteredSemanticByParent.get(params.conversation.root.id) ?? [];
  const hasRootContent = Boolean(rootMarkdown) || rootComments.length > 0 || rootSemantic.length > 0;
  if (hasRootContent) {
    lines.push("Current thread:");
    lines.push(formatNodeLine(params.conversation.root));
    if (params.conversation.root.url) lines.push(`  ${params.conversation.root.url}`);
    if (rootMarkdown) lines.push(indentBlock(rootMarkdown, "  "));
    if (rootComments.length > 0) {
      lines.push("  Comments:");
      for (const comment of rootComments) {
        lines.push(`  ${formatCommentLine(comment)}`);
        if (comment.url) lines.push(`    ${comment.url}`);
        const body = clampText(normalizeMarkdown(comment.body), maxCommentChars);
        if (body) lines.push(indentBlock(body, "    "));
      }
    }
    if (rootSemantic.length > 0) {
      lines.push("  Similar (semantic):");
      const entries = [...rootSemantic].sort((a, b) => b.similarity - a.similarity).slice(0, DEFAULT_SIMILARITY_TOP_K);
      for (const entry of entries) {
        lines.push(`  ${formatDescriptorLine(entry.descriptor, { similarity: entry.similarity })}`);
        if (entry.descriptor.url) lines.push(`    ${entry.descriptor.url}`);
        if (entry.matchedBy) lines.push(`    matched by: ${entry.matchedBy}`);
        const markdown = normalizeMarkdown(entry.doc.markdown);
        if (markdown) lines.push(indentBlock(markdown, "    "));
      }
    }
  }

  if (filteredExplicitNodes.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Conversation links (auto-merged):");
    for (const node of filteredExplicitNodes.slice(0, maxItems)) {
      lines.push(formatNodeLine(node));
      if (node.url) lines.push(`  ${node.url}`);
      const markdown = nodeBodyMap.get(node.id) ?? "";
      if (markdown) lines.push(indentBlock(markdown, "  "));
      const comments = commentMap.get(node.id) ?? [];
      if (comments.length > 0) {
        lines.push("  Comments:");
        for (const comment of comments) {
          lines.push(`  ${formatCommentLine(comment)}`);
          if (comment.url) lines.push(`    ${comment.url}`);
          const body = clampText(normalizeMarkdown(comment.body), maxCommentChars);
          if (body) lines.push(indentBlock(body, "    "));
        }
      }
      const semantic = filteredSemanticByParent.get(node.id) ?? [];
      if (semantic.length > 0) {
        lines.push("  Similar (semantic):");
        const entries = [...semantic].sort((a, b) => b.similarity - a.similarity).slice(0, DEFAULT_SIMILARITY_TOP_K);
        for (const entry of entries) {
          lines.push(`  ${formatDescriptorLine(entry.descriptor, { similarity: entry.similarity })}`);
          if (entry.descriptor.url) lines.push(`    ${entry.descriptor.url}`);
          if (entry.matchedBy) lines.push(`    matched by: ${entry.matchedBy}`);
          const entryMarkdown = normalizeMarkdown(entry.doc.markdown);
          if (entryMarkdown) lines.push(indentBlock(entryMarkdown, "    "));
        }
      }
    }
  }

  if (lines.length === 0) return "";

  return clampText(lines.join("\n"), maxChars);
}
