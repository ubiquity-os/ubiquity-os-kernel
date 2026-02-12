import { safeSendTelegramMessage, TELEGRAM_MESSAGE_LIMIT, type TelegramApiLogger } from "./api-client.ts";
import { normalizePositiveInt } from "./normalization.ts";

function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeTelegramHtmlAttribute(text: string): string {
  return escapeTelegramHtml(text).replace(/"/g, "&quot;");
}

export type ConversationGraphFilters = {
  includeBots: boolean;
  includeCommands: boolean;
};

export type ConversationGraphPlan = {
  headerLines: string[];
  nodes: ConversationGraphNodePlan[];
};

type ConversationGraphNodePlan = {
  lines: string[];
  commentBlocks: string[][];
};

type ParsedConversationNode = {
  headerLine: string;
  url?: string;
  bodyLines: string[];
  comments: ParsedConversationComment[];
  section?: string;
};

type ParsedConversationComment = {
  headerLine: string;
  url?: string;
  bodyLines: string[];
};

export function buildConversationGraphPlan(params: {
  conversationContext: string;
  query: string;
  filters: ConversationGraphFilters;
  maxNodes?: number;
  maxComments?: number;
}): ConversationGraphPlan {
  const headerLines: string[] = [];
  headerLines.push("<u><b>Conversation graph context</b></u>");
  headerLines.push(`Query: <code>${escapeTelegramHtml(params.query)}</code>`);
  const filterLabel = formatConversationFilterLabel(params.filters);
  if (filterLabel) {
    headerLines.push(`Filters: <i>${escapeTelegramHtml(filterLabel)}</i>`);
  }

  if (!params.conversationContext.trim()) {
    headerLines.push("");
    headerLines.push("No conversation graph data found for this context.");
    return { headerLines, nodes: [] };
  }

  const parsedNodes = parseConversationGraphNodes(params.conversationContext, params.filters);
  const limitedNodes = applyConversationGraphLimits(parsedNodes, params.maxNodes, params.maxComments);
  const nodes = limitedNodes.map(formatConversationGraphNodePlan);
  return { headerLines, nodes };
}

function applyConversationGraphLimits(nodes: ParsedConversationNode[], maxNodes?: number, maxComments?: number): ParsedConversationNode[] {
  const normalizedNodes = normalizePositiveInt(maxNodes);
  const normalizedComments = normalizePositiveInt(maxComments);
  const limitedNodes = normalizedNodes ? nodes.slice(0, normalizedNodes) : nodes;
  if (!normalizedComments) return limitedNodes;
  return limitedNodes.map((node) => ({
    ...node,
    comments: node.comments.slice(0, normalizedComments),
  }));
}

function formatConversationGraphNodePlan(node: ParsedConversationNode): ConversationGraphNodePlan {
  const lines: string[] = [];
  const headerText = simplifyNodeHeader(node.headerLine);
  lines.push(formatConversationHeaderLink(headerText, node.url));
  const bodyLines = formatConversationGraphLinesFromRaw(node.bodyLines);
  if (bodyLines.length > 0) {
    lines.push("");
    lines.push(...bodyLines);
  }

  const commentBlocks = node.comments.map((comment) => {
    const commentLines: string[] = [];
    const commentHeader = simplifyCommentHeader(comment.headerLine);
    commentLines.push(formatConversationHeaderLink(commentHeader, comment.url));
    const formatted = formatConversationGraphLinesFromRaw(comment.bodyLines);
    if (formatted.length > 0) {
      commentLines.push("");
      commentLines.push(...formatted);
    }
    return commentLines;
  });

  return { lines, commentBlocks };
}

function parseConversationGraphNodes(conversationContext: string, filters: ConversationGraphFilters): ParsedConversationNode[] {
  const lines = conversationContext.split("\n");
  const nodes: ParsedConversationNode[] = [];
  let currentNode: ParsedConversationNode | null = null;
  let currentComment: ParsedConversationComment | null = null;
  let section: string | undefined;
  let isInComments = false;

  function flushComment(): void {
    if (!currentComment || !currentNode) {
      currentComment = null;
      return;
    }
    const meta = parseCommentHeader(currentComment.headerLine);
    const blockLines = [currentComment.headerLine, ...currentComment.bodyLines];
    if (!shouldSkipCommentBlock(meta, blockLines, filters)) {
      currentNode.comments.push(currentComment);
    }
    currentComment = null;
  }

  function flushNode(): void {
    if (!currentNode) return;
    flushComment();
    if (currentNode.comments.length > 1) {
      currentNode.comments.reverse();
    }
    nodes.push(currentNode);
    currentNode = null;
    isInComments = false;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const isTopLevel = line.trimStart() === line;
    if (!trimmed) {
      if (currentComment) {
        currentComment.bodyLines.push("");
      } else if (currentNode) {
        currentNode.bodyLines.push("");
      }
      continue;
    }

    const heading = normalizeConversationHeading(trimmed);
    if (heading) {
      flushNode();
      section = heading;
      continue;
    }

    if (trimmed === "Comments:") {
      isInComments = true;
      flushComment();
      continue;
    }

    if (isTopLevel && isNodeHeaderLine(trimmed)) {
      flushNode();
      currentNode = {
        headerLine: trimmed,
        url: undefined,
        bodyLines: [],
        comments: [],
        section,
      };
      isInComments = false;
      continue;
    }

    if (!currentNode) {
      continue;
    }

    if (isInComments) {
      const commentMeta = parseCommentHeader(trimmed);
      if (commentMeta) {
        flushComment();
        currentComment = {
          headerLine: trimmed,
          url: undefined,
          bodyLines: [],
        };
        continue;
      }

      const url = parseLeadingUrl(trimmed);
      if (url && !url.rest && currentComment && !currentComment.url) {
        currentComment.url = url.url;
        continue;
      }

      if (currentComment) {
        currentComment.bodyLines.push(stripConversationIndent(line, 4));
      } else {
        currentNode.bodyLines.push(stripConversationIndent(line, 2));
      }
      continue;
    }

    const url = parseLeadingUrl(trimmed);
    if (url && !url.rest && !currentNode.url) {
      currentNode.url = url.url;
      continue;
    }
    currentNode.bodyLines.push(stripConversationIndent(line, 2));
  }

  flushNode();
  return nodes;
}

function stripConversationIndent(line: string, maxSpaces: number): string {
  let trimmed = line;
  let count = 0;
  while (count < maxSpaces && trimmed.startsWith(" ")) {
    trimmed = trimmed.slice(1);
    count += 1;
  }
  return trimmed;
}

function isNodeHeaderLine(line: string): boolean {
  const match = /^-\s*\[([^\]]+)\]\s+/.exec(line);
  if (!match) return false;
  const label = normalizeConversationLabel(match[1]);
  return label === "Issue" || label === "PR";
}

function simplifyNodeHeader(line: string): string {
  const match = /^-\s*\[[^\]]+\]\s*(.+)$/.exec(line);
  const rest = match?.[1]?.trim() ?? line.trim();
  const [repoPart, ...titleParts] = rest.split(" - ");
  const repoLabel = repoPart.trim();
  const title = titleParts.join(" - ").trim();
  if (title) return `${repoLabel} — ${title}:`;
  return `${repoLabel}:`;
}

function simplifyCommentHeader(line: string): string {
  const meta = parseCommentHeader(line);
  const author = meta?.author ? `@${meta.author}` : "unknown";
  const date = extractDateFromLine(line);
  if (date) return `${author} on ${date}:`;
  return `${author}:`;
}

function extractDateFromLine(line: string): string {
  const match = /\b\d{4}-\d{2}-\d{2}\b/.exec(line);
  return match ? match[0] : "";
}

function formatConversationHeaderLink(text: string, url?: string): string {
  const escaped = escapeTelegramHtml(text);
  if (url) {
    const href = escapeTelegramHtmlAttribute(url);
    return `<u><b><a href="${href}">${escaped}</a></b></u>`;
  }
  return `<u><b>${escaped}</b></u>`;
}

function formatConversationGraphLinesFromRaw(rawLines: string[]): string[] {
  const lines: string[] = [];
  let pendingBullet: { index: number; label: string; text: string } | null = null;
  let isInCodeBlock = false;
  let codeFence = "```";
  let codeBuffer: string[] = [];

  function emitLine(rawLine: string): void {
    const trimmedRaw = rawLine.trimEnd();
    const trimmed = trimmedRaw.trim();
    if (isInCodeBlock) {
      if (trimmed.startsWith(codeFence)) {
        const codeText = codeBuffer.join("\n");
        lines.push(`<pre><code>${escapeTelegramHtml(codeText)}</code></pre>`);
        isInCodeBlock = false;
        codeBuffer = [];
        return;
      }
      codeBuffer.push(rawLine);
      return;
    }
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      isInCodeBlock = true;
      codeFence = trimmed.slice(0, 3);
      codeBuffer = [];
      return;
    }
    if (!trimmed) {
      pendingBullet = null;
      if (lines[lines.length - 1] !== "") lines.push("");
      return;
    }
    const heading = normalizeConversationHeading(trimmed);
    if (heading) {
      pendingBullet = null;
      if (lines[lines.length - 1] !== "") lines.push("");
      lines.push(formatConversationHeadingLine(heading));
      return;
    }
    const bulletMatch = /^-\s*\[([^\]]+)\]\s*(.+)$/.exec(trimmed);
    if (bulletMatch) {
      const label = normalizeConversationLabel(bulletMatch[1]);
      const rest = bulletMatch[2].replace(/\s+-\s+/g, " — ");
      const text = formatConversationInline(rest);
      const line = `• <b>${escapeTelegramHtml(label)}</b> ${text}`.trim();
      lines.push(line);
      pendingBullet = { index: lines.length - 1, label, text: rest };
      return;
    }
    const leadingUrl = parseLeadingUrl(trimmed);
    if (leadingUrl && pendingBullet && !leadingUrl.rest) {
      const url = escapeTelegramHtmlAttribute(leadingUrl.url);
      const linkedText = formatConversationLinkText(pendingBullet.text);
      lines[pendingBullet.index] = `• <b>${escapeTelegramHtml(pendingBullet.label)}</b> <a href="${url}">${linkedText}</a>`;
      pendingBullet = null;
      return;
    }
    pendingBullet = null;
    if (trimmed.startsWith("matched by:")) {
      lines.push(`<i>${escapeTelegramHtml(trimmed)}</i>`);
      return;
    }
    const formatted = formatConversationBodyLine(trimmedRaw);
    if (!formatted) return;
    lines.push(formatted);
  }

  for (const raw of rawLines) {
    emitLine(raw);
  }
  if (isInCodeBlock && codeBuffer.length > 0) {
    const codeText = codeBuffer.join("\n");
    lines.push(`<pre><code>${escapeTelegramHtml(codeText)}</code></pre>`);
  }
  return lines;
}

export function parseConversationGraphArgs(rawArgs: string): { query: string; filters: ConversationGraphFilters } {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  let includeBots = false;
  let includeCommands = false;
  const queryTokens: string[] = [];
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (normalized === "--all" || normalized === "--raw") {
      includeBots = true;
      includeCommands = true;
      continue;
    }
    if (normalized === "--include-bots") {
      includeBots = true;
      continue;
    }
    if (normalized === "--include-commands") {
      includeCommands = true;
      continue;
    }
    queryTokens.push(token);
  }
  return {
    query: queryTokens.join(" ").trim(),
    filters: {
      includeBots,
      includeCommands,
    },
  };
}

function formatConversationInline(text: string): string {
  const parts = text.split("`");
  if (parts.length === 1) {
    return formatConversationInlineSegment(text);
  }
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i % 2 === 1) {
      out.push(`<code>${escapeTelegramHtml(part)}</code>`);
    } else {
      out.push(formatConversationInlineSegment(part));
    }
  }
  return out.join("");
}

function formatConversationLinkText(text: string): string {
  return escapeTelegramHtml(text);
}

function formatConversationHeadingLine(heading: string): string {
  const escaped = escapeTelegramHtml(heading);
  return `<u><b>${escaped}</b></u>`;
}

function formatConversationBodyLine(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) {
    return `<span class="tg-spoiler">${escapeTelegramHtml(trimmed)}</span>`;
  }
  if (trimmed.startsWith(">")) {
    const quote = trimmed.replace(/^>\s?/, "");
    const formatted = formatConversationInline(quote);
    return `<blockquote>${formatted}</blockquote>`;
  }
  const listMatch = /^[-*]\s+(.+)$/.exec(trimmed);
  if (listMatch) {
    const formatted = formatConversationInline(listMatch[1]);
    return `• ${formatted}`;
  }
  return formatConversationInline(trimmed);
}

function formatConversationInlineSegment(raw: string): string {
  const segments = splitUrls(raw);
  if (!segments.length) return applyInlineStyles(escapeTelegramHtml(raw));
  const out: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "url") {
      const href = escapeTelegramHtmlAttribute(segment.value);
      out.push(`<a href="${href}">${escapeTelegramHtml(segment.value)}</a>`);
    } else {
      out.push(applyInlineStyles(escapeTelegramHtml(segment.value)));
    }
  }
  return out.join("");
}

const TELEGRAM_URL_PATTERN = "https?:\\/\\/[^\\s<>\"']+";

function splitUrls(raw: string): Array<{ kind: "text" | "url"; value: string }> {
  const regex = new RegExp(TELEGRAM_URL_PATTERN, "g");
  const segments: Array<{ kind: "text" | "url"; value: string }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const start = match.index;
    if (start > lastIndex) {
      segments.push({ kind: "text", value: raw.slice(lastIndex, start) });
    }
    segments.push({ kind: "url", value: match[0] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < raw.length) {
    segments.push({ kind: "text", value: raw.slice(lastIndex) });
  }
  return segments;
}

function parseLeadingUrl(line: string): { url: string; rest: string } | null {
  const match = new RegExp(`^(${TELEGRAM_URL_PATTERN})(?:\\s+(.*))?$`).exec(line.trim());
  if (!match) return null;
  return { url: match[1], rest: (match[2] ?? "").trim() };
}

function formatConversationFilterLabel(filters: ConversationGraphFilters): string {
  const hidden: string[] = [];
  if (!filters.includeBots) hidden.push("bots");
  if (!filters.includeCommands) hidden.push("command-only comments");
  if (hidden.length === 0) return "";
  return `hiding ${hidden.join(", ")}`;
}

const COMMENT_LABEL = "Comment";
const REVIEW_LABEL = "Review";
const REVIEW_COMMENT_LABEL = "Review Comment";
const ISSUE_COMMENT_LABEL = "Issue Comment";

function parseCommentHeader(line: string): { label: string; author?: string } | null {
  const match = /^-\s*\[([^\]]+)\]\s*(.+)$/.exec(line);
  if (!match) return null;
  const label = normalizeConversationLabel(match[1]);
  if (label !== COMMENT_LABEL && label !== REVIEW_LABEL && label !== REVIEW_COMMENT_LABEL) return null;
  const meta = match[2] ?? "";
  const authorMatch = /@([^\s]+)/.exec(meta);
  const author = authorMatch?.[1];
  return { label, author };
}

function shouldSkipCommentBlock(meta: { label: string; author?: string } | null, blockLines: string[], filters: ConversationGraphFilters): boolean {
  const author = meta?.author;
  const shouldSkipBots = !filters.includeBots && typeof author === "string" && Boolean(author.trim()) && isBotAuthor(author);
  const shouldSkipCommands = Boolean(meta) && !filters.includeCommands && isCommandOnlyComment(blockLines);
  return shouldSkipBots || shouldSkipCommands;
}

function isBotAuthor(author: string): boolean {
  const normalized = author.trim().toLowerCase();
  return Boolean(normalized) && (normalized.includes("[bot]") || normalized.endsWith("-bot") || normalized.endsWith("_bot"));
}

function isCommandOnlyComment(blockLines: string[]): boolean {
  const bodyLines = extractCommentBodyLines(blockLines);
  return bodyLines.length === 0 || bodyLines.every((line) => /^\/[\w-]+(\s|$)/.test(line));
}

function extractCommentBodyLines(blockLines: string[]): string[] {
  const body: string[] = [];
  for (let i = 1; i < blockLines.length; i += 1) {
    const trimmed = blockLines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      continue;
    }
    if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) continue;
    if (/^<\/?[a-zA-Z][^>]*>$/.test(trimmed)) continue;
    body.push(trimmed);
  }
  return body;
}

function trimEmptyEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) start += 1;
  while (end > start && !lines[end - 1]?.trim()) end -= 1;
  return lines.slice(start, end);
}

function applyInlineStyles(escaped: string): string {
  let styled = escaped;
  styled = styled.replace(/\|\|([^|]+)\|\|/g, '<span class="tg-spoiler">$1</span>');
  styled = styled.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  styled = styled.replace(/(^|\s)__([^_]+)__(?=\s|$)/g, "$1<u><b>$2</b></u>");
  styled = styled.replace(/(^|\s)\*\*([^*]+)\*\*(?=\s|$)/g, "$1<b>$2</b>");
  styled = styled.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, "$1<i>$2</i>");
  styled = styled.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1<i>$2</i>");
  return styled;
}

function normalizeConversationHeading(value: string): string | null {
  const trimmed = value.replace(/:$/, "").trim();
  if (!trimmed) return null;
  if (trimmed === "Current thread" || trimmed === "Conversation links (auto-merged)" || trimmed === "Comments" || trimmed === "Similar (semantic)") {
    return trimmed;
  }
  return null;
}

function normalizeConversationLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed === ISSUE_COMMENT_LABEL) return COMMENT_LABEL;
  if (trimmed === REVIEW_COMMENT_LABEL) return REVIEW_COMMENT_LABEL;
  if (trimmed === REVIEW_LABEL) return REVIEW_LABEL;
  if (trimmed === "PullRequest") return "PR";
  return trimmed || "Item";
}

function splitTelegramMessageLines(lines: string[], limit: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (!line) {
      const extra = current.length ? 1 : 0;
      if (length + extra <= limit) {
        current.push("");
        length += extra;
        continue;
      }
      if (current.length) {
        chunks.push(current.join("\n"));
        current = [""];
        length = 0;
      }
      continue;
    }
    const lineLength = line.length;
    if (lineLength > limit) {
      if (current.length) {
        chunks.push(current.join("\n"));
        current = [];
        length = 0;
      }
      const suffix = "...";
      const truncated = line.slice(0, Math.max(0, limit - suffix.length)) + suffix;
      chunks.push(truncated);
      continue;
    }
    const extra = (current.length ? 1 : 0) + lineLength;
    if (length + extra > limit && current.length) {
      chunks.push(current.join("\n"));
      current = [line];
      length = lineLength;
      continue;
    }
    current.push(line);
    length = current.length === 1 ? lineLength : length + 1 + lineLength;
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

async function sendTelegramMessageChunked(params: {
  botToken: string;
  chatId: number;
  replyToMessageId?: number;
  lines: string[];
  parseMode?: "HTML" | "MarkdownV2";
  disablePreview?: boolean;
  disableNotification?: boolean;
  logger: TelegramApiLogger;
}): Promise<number | null> {
  const trimmed = trimEmptyEdges(params.lines);
  if (trimmed.length === 0) return null;
  const chunks = splitTelegramMessageLines(trimmed, TELEGRAM_MESSAGE_LIMIT);
  let firstMessageId: number | null = null;
  let threadId = params.replyToMessageId;
  for (const chunk of chunks) {
    const messageId = await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: threadId,
      text: chunk,
      parseMode: params.parseMode,
      disablePreview: params.disablePreview,
      disableNotification: params.disableNotification,
      shouldTruncate: false,
      logger: params.logger,
    });
    if (!firstMessageId && messageId) {
      firstMessageId = messageId;
      threadId = firstMessageId;
    } else if (firstMessageId) {
      threadId = firstMessageId;
    }
  }
  return firstMessageId;
}

export async function sendTelegramConversationGraph(params: {
  botToken: string;
  chatId: number;
  replyToMessageId?: number;
  plan: ConversationGraphPlan;
  parseMode?: "HTML" | "MarkdownV2";
  disablePreview?: boolean;
  disableNotification?: boolean;
  logger: TelegramApiLogger;
}): Promise<void> {
  const headerId = await sendTelegramMessageChunked({
    botToken: params.botToken,
    chatId: params.chatId,
    replyToMessageId: params.replyToMessageId,
    lines: params.plan.headerLines,
    parseMode: params.parseMode,
    disablePreview: params.disablePreview,
    disableNotification: params.disableNotification,
    logger: params.logger,
  });

  for (const node of params.plan.nodes) {
    const nodeReplyTo = headerId ?? params.replyToMessageId;
    const nodeId = await sendTelegramMessageChunked({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: nodeReplyTo,
      lines: node.lines,
      parseMode: params.parseMode,
      disablePreview: params.disablePreview,
      disableNotification: params.disableNotification,
      logger: params.logger,
    });
    const commentReplyTo = nodeId ?? nodeReplyTo;
    for (const comment of node.commentBlocks) {
      await sendTelegramMessageChunked({
        botToken: params.botToken,
        chatId: params.chatId,
        replyToMessageId: commentReplyTo,
        lines: comment,
        parseMode: params.parseMode,
        disablePreview: params.disablePreview,
        disableNotification: params.disableNotification,
        logger: params.logger,
      });
    }
  }
}
