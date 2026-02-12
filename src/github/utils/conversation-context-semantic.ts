import { GitHubContext } from "../github-context.ts";
import { ConversationNode } from "./conversation-graph.ts";
import { selectIncludeIdsWithRouter } from "./selector-response.ts";
import type { VectorDocument } from "./vector-db.ts";
import {
  clampText,
  COMMENT_DOC_TYPES,
  type CommentEntry,
  DEFAULT_SELECTOR_BATCH_SIZE,
  DEFAULT_SELECTOR_MAX_BODY_CHARS,
  DEFAULT_SELECTOR_MAX_CANDIDATES,
  DEFAULT_SELECTOR_MAX_COMMENT_CHARS,
  DEFAULT_SELECTOR_MAX_COMMENTS,
  DEFAULT_SELECTOR_TIMEOUT_MS,
  type DocumentKind,
  formatDateLabel,
  isRecord,
  normalizeMarkdown,
  type SelectionCandidate,
} from "./conversation-context-helpers.ts";

export type DocumentDescriptor = Readonly<{
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

export function buildNodeFromDocument(doc: VectorDocument): ConversationNode | null {
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

export function buildDescriptorFromDocument(doc: VectorDocument): DocumentDescriptor | null {
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

export function formatDescriptorLine(descriptor: DocumentDescriptor, options: Readonly<{ similarity?: number }> = {}): string {
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

export function formatSeedLabel(doc: VectorDocument): string {
  const descriptor = buildDescriptorFromDocument(doc);
  if (!descriptor) return doc.id;
  return formatDescriptorLine(descriptor).replace(/^- /, "");
}

export function formatMatchedBy(labels: string[]): string {
  if (labels.length === 0) return "";
  const trimmed = labels.slice(0, 3);
  const extra = labels.length - trimmed.length;
  const suffix = extra > 0 ? ` +${extra} more` : "";
  return `${trimmed.join("; ")}${suffix}`;
}

export function getDocumentTimestamp(doc: VectorDocument): number | null {
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

export async function selectConversationCandidates(
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

  const maxSelections = Math.max(1, Math.trunc(params.maxSelections));
  const selected = await selectIncludeIdsWithRouter({
    context: params.context,
    query,
    prompt: buildSelectorPrompt(maxSelections),
    candidates: params.candidates,
    candidateId: (candidate) => candidate.id,
    buildRouterInput: (batch) => ({
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
    }),
    maxSelections,
    timeoutMs: DEFAULT_SELECTOR_TIMEOUT_MS,
    batchSize: DEFAULT_SELECTOR_BATCH_SIZE,
    maxCandidates: DEFAULT_SELECTOR_MAX_CANDIDATES,
    logger: params.context.logger,
    parseFailureMessage: "Selector response did not parse",
    callFailureMessage: "Selector call failed (non-fatal)",
  });
  if (!selected) return null;
  return new Set<string>([params.root.id, ...selected]);
}

export { buildSelectorCandidateFromNode, buildSelectorCandidateFromSemantic };
