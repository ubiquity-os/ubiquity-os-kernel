import type { ConversationNode } from "../src/github/utils/conversation-graph.ts";

const TITLE_MAX_CHARS = 120;
const COMMENT_SNIPPET_CHARS = 120;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function formatDateLabel(value: string): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toISOString().slice(0, 10);
}

function getCommentKindLabel(kind: string): string {
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

export type CommentNodeDisplay = Readonly<{
  id: string;
  kind: string;
  createdAt: string;
  url: string;
  author: string;
  body: string;
}>;

export type CommentListDisplay = Readonly<{
  total: number;
  nodes: CommentNodeDisplay[];
}>;

export type SimilarityMatchDisplay = Readonly<{
  similarity: number;
  node: ConversationNode | CommentNodeDisplay;
}>;

export function formatNode(node: ConversationNode): string {
  const typeLabel = node.type === "Issue" ? "Issue" : "PR";
  const repoLabel = node.owner && node.repo ? `${node.owner}/${node.repo}` : "unknown/unknown";
  const numberLabel = typeof node.number === "number" ? `#${node.number}` : "";
  const title = node.title ? ` - ${truncate(node.title, TITLE_MAX_CHARS)}` : "";
  return `[${typeLabel}] ${repoLabel}${numberLabel}${title}`;
}

function formatCommentNode(node: CommentNodeDisplay): string {
  const kindLabel = getCommentKindLabel(node.kind);
  const authorLabel = node.author ? `@${node.author}` : "unknown";
  const dateLabel = formatDateLabel(node.createdAt);
  const snippet = node.body ? truncate(node.body, COMMENT_SNIPPET_CHARS) : "";
  const meta = [authorLabel, dateLabel].filter(Boolean).join(" ");
  const snippetLabel = snippet ? ` - ${snippet}` : "";
  return `[${kindLabel}] ${meta}${snippetLabel}`;
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

export function resolveColorMode(mode: "auto" | "always" | "never"): boolean {
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

export function styleHeader(text: string, isColorEnabled: boolean): string {
  return colorize(text, COLOR.header, isColorEnabled);
}

export function styleLabel(text: string, isColorEnabled: boolean): string {
  return colorize(text, COLOR.label, isColorEnabled);
}

export function styleValue(text: string, isColorEnabled: boolean): string {
  return colorize(text, COLOR.value, isColorEnabled);
}

export function styleDim(text: string, isColorEnabled: boolean): string {
  return colorize(text, COLOR.dim, isColorEnabled);
}

function formatSectionHeader(title: string, count: number | string | null, isColorEnabled: boolean): string {
  const label = styleLabel(title, isColorEnabled);
  if (count === null) return label;
  const countLabel = `[${count}]`;
  return `${label} ${styleDim(countLabel, isColorEnabled)}`;
}

export function renderSection(
  title: string,
  options: Readonly<{
    count?: number | string;
    isLast: boolean;
    isColorEnabled: boolean;
    indent?: string;
  }>
): string {
  const branch = options.isLast ? "`--" : "|--";
  const indent = options.indent ?? "";
  const header = formatSectionHeader(title, options.count ?? null, options.isColorEnabled);
  console.log(`${indent}${styleDim(branch, options.isColorEnabled)} ${header}`);
  return `${indent}${options.isLast ? "    " : "|   "}`;
}

export function renderNodeList(
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

export function renderCommentList(
  nodes: CommentNodeDisplay[],
  isColorEnabled: boolean,
  indent: string,
  similarityById: Map<string, SimilarityMatchDisplay[]>
): void {
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

    const matches = similarityById.get(node.id) ?? [];
    if (matches.length > 0) {
      const sectionIndent = renderSection("Similar", {
        count: matches.length,
        isLast: true,
        isColorEnabled,
        indent: `${indent}${childIndent}`,
      });
      renderSimilarityList(matches, isColorEnabled, sectionIndent);
    }
  });
}

export function renderNodeListWithComments(
  nodes: ConversationNode[],
  commentsById: Map<string, CommentListDisplay>,
  isColorEnabled: boolean,
  similarityById: Map<string, SimilarityMatchDisplay[]>,
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

    const sections: Array<{
      title: string;
      count: number | string;
      render: (sectionIndent: string) => void;
    }> = [];
    const commentList = commentsById.get(node.id);
    if (commentList && commentList.nodes.length > 0) {
      const countLabel = commentList.total > commentList.nodes.length ? `${commentList.nodes.length}/${commentList.total}` : commentList.total;
      sections.push({
        title: "Comments",
        count: countLabel,
        render: (sectionIndent) => renderCommentList(commentList.nodes, isColorEnabled, sectionIndent, similarityById),
      });
    }
    const matches = similarityById.get(node.id) ?? [];
    if (matches.length > 0) {
      sections.push({
        title: "Similar",
        count: matches.length,
        render: (sectionIndent) => renderSimilarityList(matches, isColorEnabled, sectionIndent),
      });
    }

    sections.forEach((section, sectionIndex) => {
      const sectionIndent = renderSection(section.title, {
        count: section.count,
        isLast: sectionIndex === sections.length - 1,
        isColorEnabled,
        indent: `${indent}${childIndent}`,
      });
      section.render(sectionIndent);
    });
  });
}

function isCommentNode(node: ConversationNode | CommentNodeDisplay): node is CommentNodeDisplay {
  return "kind" in node;
}

function formatSimilarityMatch(match: SimilarityMatchDisplay): string {
  const base = isCommentNode(match.node) ? formatCommentNode(match.node) : formatNode(match.node as ConversationNode);
  return `${base} (sim ${match.similarity.toFixed(2)})`;
}

export function renderSimilarityList(matches: SimilarityMatchDisplay[], isColorEnabled: boolean, indent: string): void {
  if (!matches.length) {
    console.log(`${indent}\`-- ${styleDim("(none)", isColorEnabled)}`);
    return;
  }
  matches.forEach((match, index) => {
    const isLast = index === matches.length - 1;
    const branch = isLast ? "`--" : "|--";
    const childIndent = isLast ? "    " : "|   ";
    const nodeText = formatSimilarityMatch(match);
    console.log(`${indent}${styleDim(branch, isColorEnabled)} ${styleValue(nodeText, isColorEnabled)}`);
    if (match.node.url) {
      console.log(`${indent}${childIndent}${styleDim(match.node.url, isColorEnabled)}`);
    }
  });
}
