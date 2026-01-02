import { GitHubContext } from "../github-context";
import { ConversationNode, ConversationKeyResult, listConversationNodesForKey } from "./conversation-graph";
import { fetchVectorDocument, fetchVectorDocuments, findSimilarIssues, getVectorDbConfig, VectorDocument } from "./vector-db";

const DEFAULT_MAX_ITEMS = 10;
const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_SNIPPET_CHARS = 260;
const DEFAULT_SIMILARITY_THRESHOLD = 0.8;
const DEFAULT_SIMILARITY_TOP_K = 5;
const DEFAULT_AUTHOR_BOOST = 0.07;
const DEFAULT_OWNER_BOOST = 0.04;
const DEFAULT_RECENCY_BOOST = 0.06;

function clampText(value: string, maxChars: number): string {
  const text = value.trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function formatNodeLine(node: ConversationNode): string {
  const typeLabel = node.type === "Issue" ? "Issue" : "PR";
  const repoLabel = node.owner && node.repo ? `${node.owner}/${node.repo}` : "unknown";
  const numberLabel = typeof node.number === "number" ? `#${node.number}` : "";
  const title = node.title ? ` - ${node.title}` : "";
  return `- [${typeLabel}] ${repoLabel}${numberLabel}${title}`;
}

function snippetFromMarkdown(markdown: string | null, maxChars: number): string {
  if (!markdown) return "";
  const cleaned = markdown.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}...`;
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

function getRepositoryOwner(context: GitHubContext): string {
  const payload = context.payload as Record<string, unknown>;
  const repository = isRecord(payload.repository) ? payload.repository : null;
  const owner = isRecord(repository?.owner) ? repository?.owner : null;
  return typeof owner?.login === "string" ? owner.login.trim().toLowerCase() : "";
}

function buildNodeFromDocument(doc: VectorDocument): ConversationNode | null {
  const payload = isRecord(doc.payload) ? (doc.payload as Record<string, unknown>) : null;
  if (!payload) return null;
  const repository = isRecord(payload.repository) ? payload.repository : null;
  const owner = isRecord(repository?.owner) ? String(repository.owner.login || "").trim() : "";
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

function getDocumentTimestamp(doc: VectorDocument): number | null {
  const payload = isRecord(doc.payload) ? (doc.payload as Record<string, unknown>) : null;
  if (!payload) return null;
  const issue = isRecord(payload.issue) ? payload.issue : null;
  const pullRequest = isRecord(payload.pull_request) ? payload.pull_request : null;
  let source: Record<string, unknown> | null = null;
  if (doc.docType === "issue") {
    source = issue;
  } else if (doc.docType === "pull_request") {
    source = pullRequest;
  }
  if (!source) return null;
  const updatedAt = typeof source.updated_at === "string" ? source.updated_at : "";
  const createdAt = typeof source.created_at === "string" ? source.created_at : "";
  const parsed = Date.parse(updatedAt || createdAt);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function buildConversationContext(
  params: Readonly<{
    context: GitHubContext;
    conversation: ConversationKeyResult;
    maxItems?: number;
    maxChars?: number;
    includeSemantic?: boolean;
  }>
): Promise<string> {
  const maxItems = typeof params.maxItems === "number" && Number.isFinite(params.maxItems) ? Math.max(1, Math.trunc(params.maxItems)) : DEFAULT_MAX_ITEMS;
  const maxChars = typeof params.maxChars === "number" && Number.isFinite(params.maxChars) ? Math.max(200, Math.trunc(params.maxChars)) : DEFAULT_MAX_CHARS;
  const includeSemantic = params.includeSemantic !== false;

  const keyNodes = await listConversationNodesForKey(params.context, params.conversation.key, maxItems * 2, params.context.logger);
  const explicitNodes = dedupeNodes([...params.conversation.linked, ...keyNodes]).filter((node) => node.id !== params.conversation.root.id);

  const config = includeSemantic ? getVectorDbConfig(params.context.logger) : null;
  const docMap = new Map<string, VectorDocument>();
  if (config) {
    const explicitDocs = await fetchVectorDocuments(
      config,
      explicitNodes.map((node) => node.id)
    );
    for (const doc of explicitDocs) docMap.set(doc.id, doc);
  }

  const semanticNodes: ConversationNode[] = [];
  if (config) {
    const rootDoc = await fetchVectorDocument(config, params.conversation.root.id);
    if (rootDoc?.embedding && rootDoc.embedding.length > 0) {
      const similar = await findSimilarIssues(config, {
        currentId: params.conversation.root.id,
        embedding: rootDoc.embedding,
        threshold: DEFAULT_SIMILARITY_THRESHOLD,
        topK: DEFAULT_SIMILARITY_TOP_K,
      });
      const candidateIds = similar.map((item) => item.id).filter((id) => id !== params.conversation.root.id);
      const candidateDocs = await fetchVectorDocuments(config, candidateIds);
      for (const doc of candidateDocs) docMap.set(doc.id, doc);

      const participants = collectParticipantIds(params.context);
      const repoOwner = getRepositoryOwner(params.context);
      const scoredSeed = similar
        .map((item) => {
          const doc = docMap.get(item.id);
          const node = doc ? buildNodeFromDocument(doc) : null;
          if (!doc || !node) return null;
          const timestampMs = getDocumentTimestamp(doc);
          return { node, doc, similarity: item.similarity, timestampMs };
        })
        .filter((row): row is { node: ConversationNode; doc: VectorDocument; similarity: number; timestampMs: number | null } => Boolean(row));
      const timeValues = scoredSeed.map((row) => row.timestampMs).filter((value): value is number => typeof value === "number");
      const minTime = timeValues.length ? Math.min(...timeValues) : null;
      const maxTime = timeValues.length ? Math.max(...timeValues) : null;
      const timeRange = minTime !== null && maxTime !== null ? maxTime - minTime : 0;
      const scored = scoredSeed.map((row) => {
        const authorBoost = row.doc.authorId !== null && participants.has(row.doc.authorId) ? DEFAULT_AUTHOR_BOOST : 0;
        const ownerBoost = repoOwner && row.node.owner.toLowerCase() === repoOwner ? DEFAULT_OWNER_BOOST : 0;
        const recency = timeRange > 0 && typeof row.timestampMs === "number" && minTime !== null ? (row.timestampMs - minTime) / timeRange : 1;
        const recencyBoost = timeRange > 0 ? recency * DEFAULT_RECENCY_BOOST : 0;
        return { node: row.node, score: row.similarity + authorBoost + ownerBoost + recencyBoost };
      });

      scored.sort((a, b) => b.score - a.score);
      for (const entry of scored) {
        semanticNodes.push(entry.node);
      }
    }
  }

  const explicitSet = new Set(explicitNodes.map((node) => node.id));
  const semanticFiltered = semanticNodes.filter((node) => !explicitSet.has(node.id));
  const related = [...explicitNodes, ...semanticFiltered];

  if (related.length === 0) return "";

  const lines: string[] = [];
  if (explicitNodes.length > 0) {
    lines.push("Conversation links (auto-merged):");
    for (const node of explicitNodes.slice(0, maxItems)) {
      lines.push(formatNodeLine(node));
      if (node.url) lines.push(`  ${node.url}`);
      const snippet = docMap.has(node.id) ? snippetFromMarkdown(docMap.get(node.id)?.markdown ?? null, DEFAULT_SNIPPET_CHARS) : "";
      if (snippet) lines.push(`  ${snippet}`);
    }
  }

  if (semanticFiltered.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Related threads (semantic):");
    for (const node of semanticFiltered.slice(0, maxItems)) {
      lines.push(formatNodeLine(node));
      if (node.url) lines.push(`  ${node.url}`);
      const snippet = docMap.has(node.id) ? snippetFromMarkdown(docMap.get(node.id)?.markdown ?? null, DEFAULT_SNIPPET_CHARS) : "";
      if (snippet) lines.push(`  ${snippet}`);
    }
  }

  return clampText(lines.join("\n"), maxChars);
}
