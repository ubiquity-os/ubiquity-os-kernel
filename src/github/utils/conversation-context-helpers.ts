import { ConversationNode } from "./conversation-graph.ts";

export const DEFAULT_MAX_ITEMS = 10;
export const DEFAULT_MAX_CHARS = 4000;
export const DEFAULT_MAX_COMMENTS = 8;
export const DEFAULT_MAX_COMMENT_CHARS = 256;
export const DEFAULT_SIMILARITY_THRESHOLD = 0.8;
export const DEFAULT_SIMILARITY_TOP_K = 5;
export const DEFAULT_AUTHOR_BOOST = 0.07;
export const DEFAULT_OWNER_BOOST = 0.04;
export const DEFAULT_RECENCY_BOOST = 0.06;
export const DEFAULT_SELECTOR_BATCH_SIZE = 20;
export const DEFAULT_SELECTOR_MAX_CANDIDATES = 120;
export const DEFAULT_SELECTOR_MAX_BODY_CHARS = 900;
export const DEFAULT_SELECTOR_MAX_COMMENT_CHARS = 280;
export const DEFAULT_SELECTOR_MAX_COMMENTS = 6;
export const DEFAULT_SELECTOR_TIMEOUT_MS = 20_000;
export const DEFAULT_GITHUB_CONCURRENCY = 4;
export const DEFAULT_VECTOR_CONCURRENCY = 6;

export const COMMENT_DOC_TYPES = ["issue_comment", "review_comment", "pull_request_review"];

export type CommentKind = "IssueComment" | "ReviewComment" | "Review";

export type CommentEntry = Readonly<{
  id: string;
  kind: CommentKind;
  author: string;
  createdAt: string;
  url: string;
  body: string;
}>;

export type DocumentKind = "Issue" | "PullRequest" | "IssueComment" | "ReviewComment" | "PullRequestReview";

export type SelectionCandidate = Readonly<{
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

export function clampText(value: string, maxChars: number): string {
  const text = value.trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

export async function mapWithConcurrency<TItem, TResult>(items: TItem[], limit: number, handler: (item: TItem) => Promise<TResult>): Promise<TResult[]> {
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

export function formatNodeLine(node: ConversationNode): string {
  const typeLabel = node.type === "Issue" ? "Issue" : "PR";
  const repoLabel = node.owner && node.repo ? `${node.owner}/${node.repo}` : "unknown";
  const numberLabel = typeof node.number === "number" ? `#${node.number}` : "";
  const title = node.title ? ` - ${node.title}` : "";
  return `- [${typeLabel}] ${repoLabel}${numberLabel}${title}`;
}

export function indentBlock(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

export function normalizeMarkdown(markdown: string | null): string {
  if (!markdown) return "";
  const trimmed = markdown.trim();
  if (!trimmed) return "";
  return splitLeadingUrlLines(trimmed);
}

function splitLeadingUrlLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let isInFence = false;
  let fence = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const marker = trimmed.slice(0, 3);
      if (!isInFence) {
        isInFence = true;
        fence = marker;
      } else if (marker === fence) {
        isInFence = false;
      }
      out.push(line);
      continue;
    }
    if (isInFence) {
      out.push(line);
      continue;
    }
    const match = /^(https?:\/\/[^\s<>"']+)\s+(.+)$/.exec(trimmed);
    if (match) {
      out.push(match[1]);
      out.push(match[2]);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export function formatDateLabel(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toISOString().slice(0, 10);
}

function getCommentKindLabel(kind: CommentKind): string {
  if (kind === "IssueComment") return "Issue Comment";
  if (kind === "ReviewComment") return "Review Comment";
  return "Review";
}

export function formatCommentLine(comment: CommentEntry): string {
  const kindLabel = getCommentKindLabel(comment.kind);
  const author = comment.author ? `@${comment.author}` : "unknown";
  const date = formatDateLabel(comment.createdAt);
  const meta = [author, date].filter(Boolean).join(" ");
  return `- [${kindLabel}] ${meta}`.trim();
}

export function dedupeNodes(nodes: ConversationNode[]): ConversationNode[] {
  const seen = new Set<string>();
  const out: ConversationNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

export function dedupeComments(nodes: CommentEntry[]): CommentEntry[] {
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

export function sortCommentsByDate(nodes: CommentEntry[]): CommentEntry[] {
  return [...nodes].sort((a, b) => {
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    const aScore = Number.isFinite(aTime) ? aTime : 0;
    const bScore = Number.isFinite(bTime) ? bTime : 0;
    return bScore - aScore;
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
