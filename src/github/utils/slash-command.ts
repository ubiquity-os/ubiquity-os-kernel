export type SlashCommandInvocation = {
  name: string;
  rawArgs: string;
};

export function startsWithSlashCommand(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  return /^\s*\//.test(text);
}

export function parseLeadingSlashCommand(text: string | null | undefined): SlashCommandInvocation | null {
  if (typeof text !== "string") return null;
  const normalized = text.trimStart();
  if (!normalized.startsWith("/")) return null;

  const remainder = normalized.slice(1);
  const whitespaceIndex = remainder.search(/\s/);
  const token = (whitespaceIndex === -1 ? remainder : remainder.slice(0, whitespaceIndex)).trim();
  if (!token) return null;

  // Telegram can send commands like `/help@MyBot` in group chats.
  const [commandPart] = token.split("@", 1);
  const name = commandPart?.trim() ?? "";
  if (!name || !/^[\w-]+$/.test(name)) return null;

  const rawArgs = whitespaceIndex === -1 ? "" : remainder.slice(whitespaceIndex).trim();
  return {
    name,
    rawArgs,
  };
}
