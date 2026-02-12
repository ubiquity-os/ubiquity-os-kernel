import { GitHubContext } from "../github-context.ts";
import { ConversationKeyResult, ConversationNode, listConversationNodesForKey } from "./conversation-graph.ts";
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
import {
  buildDescriptorFromDocument,
  buildSelectorCandidateFromNode,
  buildSelectorCandidateFromSemantic,
  type DocumentDescriptor,
  formatDescriptorLine,
  formatMatchedBy,
  formatSeedLabel,
  getDocumentTimestamp,
  selectConversationCandidates,
} from "./conversation-context-semantic.ts";
import {
  clampText,
  COMMENT_DOC_TYPES,
  type CommentEntry,
  type CommentKind,
  dedupeComments,
  dedupeNodes,
  DEFAULT_AUTHOR_BOOST,
  DEFAULT_GITHUB_CONCURRENCY,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_COMMENT_CHARS,
  DEFAULT_MAX_COMMENTS,
  DEFAULT_MAX_ITEMS,
  DEFAULT_OWNER_BOOST,
  DEFAULT_RECENCY_BOOST,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_SIMILARITY_TOP_K,
  DEFAULT_VECTOR_CONCURRENCY,
  formatCommentLine,
  formatNodeLine,
  indentBlock,
  isRecord,
  mapWithConcurrency,
  normalizeMarkdown,
  type SelectionCandidate,
  sortCommentsByDate,
} from "./conversation-context-helpers.ts";

type ConversationContextDeps = Readonly<{
  listConversationNodesForKey: typeof listConversationNodesForKey;
  getVectorDbConfig: typeof getVectorDbConfig;
  fetchVectorDocument: typeof fetchVectorDocument;
  fetchVectorDocuments: typeof fetchVectorDocuments;
  fetchVectorDocumentsByParentId: typeof fetchVectorDocumentsByParentId;
  findSimilarIssues: typeof findSimilarIssues;
  findSimilarComments: typeof findSimilarComments;
}>;

function resolveConversationContextDeps(deps?: Partial<ConversationContextDeps>): ConversationContextDeps {
  return {
    listConversationNodesForKey,
    getVectorDbConfig,
    fetchVectorDocument,
    fetchVectorDocuments,
    fetchVectorDocumentsByParentId,
    findSimilarIssues,
    findSimilarComments,
    ...deps,
  };
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

async function findSimilarForDocument(
  config: ReturnType<typeof getVectorDbConfig>,
  doc: VectorDocument,
  deps: ConversationContextDeps,
  logger?: LoggerLike
): Promise<{ id: string; similarity: number }[]> {
  if (!config) return [];
  const embedding = Array.isArray(doc.embedding) ? doc.embedding : [];
  if (embedding.length === 0) return [];
  const [issueResults, commentResults] = await Promise.all([
    deps.findSimilarIssues(
      config,
      {
        currentId: doc.id,
        embedding,
        threshold: DEFAULT_SIMILARITY_THRESHOLD,
        topK: DEFAULT_SIMILARITY_TOP_K,
      },
      logger
    ),
    deps.findSimilarComments(
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
    deps?: Partial<ConversationContextDeps>;
  }>
): Promise<string> {
  const deps = resolveConversationContextDeps(params.deps);
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

  const keyNodes = await deps.listConversationNodesForKey(params.context, params.conversation.key, maxItems * 2, params.context.logger);
  const explicitNodes = dedupeNodes([...params.conversation.linked, ...keyNodes]).filter((node) => node.id !== params.conversation.root.id);
  const threadNodes = [params.conversation.root, ...explicitNodes];

  const commentMap = includeComments ? await fetchCommentsForNodes(params.context, threadNodes, maxComments) : new Map<string, CommentEntry[]>();

  const config = includeSemantic ? deps.getVectorDbConfig(params.context.logger) : null;
  const docMap = new Map<string, VectorDocument>();
  const graphDocIds = new Set<string>([params.conversation.root.id]);
  const seedParentMap = new Map<string, string>();
  const semanticByParent = new Map<
    string,
    Array<{
      doc: VectorDocument;
      descriptor: DocumentDescriptor;
      similarity: number;
      matchedBy: string;
    }>
  >();
  if (config) {
    const explicitDocs = await deps.fetchVectorDocuments(
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
    const rootDoc = await deps.fetchVectorDocument(config, params.conversation.root.id, params.context.logger);
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
      const comments = await deps.fetchVectorDocumentsByParentId(
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
      const matches = await findSimilarForDocument(config, doc, deps, params.context.logger);
      return { docId: doc.id, matches };
    });
    for (const result of similarityResults) {
      for (const match of result.matches) {
        if (graphDocIds.has(match.id)) continue;
        const existing = similarityById.get(match.id);
        if (existing) {
          existing.sources.add(result.docId);
          if (match.similarity > existing.similarity) {
            existing.similarity = match.similarity;
          }
        } else {
          similarityById.set(match.id, {
            similarity: match.similarity,
            sources: new Set([result.docId]),
          });
        }
      }
    }

    const candidateIds = [...similarityById.keys()];
    if (candidateIds.length > 0) {
      const candidateDocs = await deps.fetchVectorDocuments(config, candidateIds, undefined, params.context.logger);
      for (const doc of candidateDocs) {
        docMap.set(doc.id, doc);
      }

      const candidates = candidateDocs
        .map((doc) => {
          const descriptor = buildDescriptorFromDocument(doc);
          const meta = similarityById.get(doc.id);
          if (!descriptor || !meta) return null;
          const timestampMs = getDocumentTimestamp(doc);
          return {
            descriptor,
            doc,
            similarity: meta.similarity,
            sources: meta.sources,
            timestampMs,
          };
        })
        .filter(
          (
            row
          ): row is {
            descriptor: DocumentDescriptor;
            doc: VectorDocument;
            similarity: number;
            sources: Set<string>;
            timestampMs: number | null;
          } => Boolean(row)
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
        const entry = {
          doc: row.doc,
          descriptor: row.descriptor,
          similarity: row.similarity,
          matchedBy,
        };
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
        if (!candidate || candidate.id === params.conversation.root.id) {
          continue;
        }
        if (!candidateById.has(candidate.id)) {
          candidateById.set(candidate.id, candidate);
        }
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
    filteredSemanticByParent = new Map<
      string,
      Array<{
        doc: VectorDocument;
        descriptor: DocumentDescriptor;
        similarity: number;
        matchedBy: string;
      }>
    >();
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
    if (params.conversation.root.url) {
      lines.push(`  ${params.conversation.root.url}`);
    }
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
        lines.push(
          `  ${formatDescriptorLine(entry.descriptor, {
            similarity: entry.similarity,
          })}`
        );
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
          lines.push(
            `  ${formatDescriptorLine(entry.descriptor, {
              similarity: entry.similarity,
            })}`
          );
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
