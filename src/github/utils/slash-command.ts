export type SlashCommandInvocation = {
  name: string;
  rawArgs: string;
};

const SLASH_COMMAND_RE = /^\s*\/([\w-]+)\b(.*)$/s;

export function startsWithSlashCommand(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  return /^\s*\//.test(text);
}

export function parseLeadingSlashCommand(text: string | null | undefined): SlashCommandInvocation | null {
  if (typeof text !== "string") return null;
  const match = SLASH_COMMAND_RE.exec(text);
  if (!match) return null;
  return {
    name: match[1],
    rawArgs: (match[2] ?? "").trim(),
  };
}
