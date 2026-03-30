export const COMMAND_RESPONSE_MARKER = '"commentKind": "command-response"';

export type SlashCommandInvocation = Readonly<{
  name: string;
  rawArgs: string;
}>;

export type CreatedCommentRouteContext = Readonly<{
  trimmedBody: string;
  afterMention: string | null;
  slashInvocation: SlashCommandInvocation | null;
  isCommandResponse: boolean;
  isExplicitInvocation: boolean;
  isHumanAuthor: boolean;
}>;

export function hasCommandResponseMarker(body: string | null | undefined): boolean {
  return typeof body === "string" && body.includes(COMMAND_RESPONSE_MARKER);
}

export function extractSlashCommandInvocation(text: string): SlashCommandInvocation | null {
  const match = /^\s*\/([\w-]+)\b(.*)$/s.exec(text);
  if (!match) return null;
  return {
    name: match[1],
    rawArgs: (match[2] ?? "").trim(),
  };
}

export function extractAfterUbiquityosMention(text: string): string | null {
  const match = /^\s*@ubiquityos\b/i.exec(text);
  if (!match || match.index === undefined) return null;
  return text.slice(match[0].length).trim();
}

export function getCreatedCommentRouteContext(body: string | null | undefined, authorType?: string | null): CreatedCommentRouteContext {
  const normalizedBody = typeof body === "string" ? body : "";
  const afterMention = extractAfterUbiquityosMention(normalizedBody);
  const slashInvocation = afterMention !== null ? extractSlashCommandInvocation(afterMention) : extractSlashCommandInvocation(normalizedBody);
  return {
    trimmedBody: normalizedBody.trim(),
    afterMention,
    slashInvocation,
    isCommandResponse: hasCommandResponseMarker(normalizedBody),
    isExplicitInvocation: afterMention !== null || slashInvocation !== null,
    isHumanAuthor: authorType === "User",
  };
}

export function shouldSkipBotInvocationDispatch(body: string | null | undefined, authorType?: string | null): boolean {
  const routeContext = getCreatedCommentRouteContext(body, authorType);
  return !routeContext.isHumanAuthor && (routeContext.isExplicitInvocation || routeContext.isCommandResponse);
}
