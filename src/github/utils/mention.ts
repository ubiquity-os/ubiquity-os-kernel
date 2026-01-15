const LEADING_MENTION_RE = /^\s*@([a-z0-9-_]+)\b/i;

export function getLeadingMention(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const match = LEADING_MENTION_RE.exec(text);
  return match?.[1] ?? null;
}

export function isLeadingUbiquityMention(text: string | null | undefined): boolean {
  const mention = getLeadingMention(text);
  return mention?.toLowerCase() === "ubiquityos";
}
