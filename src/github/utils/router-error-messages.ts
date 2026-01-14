import { PERSONALITY_COLLECTIONS, type RouterPersonalityName } from "./router-personalities/index.ts";

const PHRASES_BY_STATUS = {
  400: ["malformed request", "parameters incorrect"],
  401: ["authentication expired", "credentials stale", "token handshake failed"],
  403: ["access denied", "permissions issue"],
  408: ["timeout", "slow response"],
  422: ["validation fail", "data mismatch"],
  429: ["rate limited", "call volume high", "back off needed"],
  500: ["server error", "backend crash", "internal fault"],
  502: ["gateway issue", "proxy down"],
  503: ["service unavailable", "overloaded"],
  504: ["upstream timeout"],
  default: ["connection glitch", "signal lost", "unexpected silence", "network hiccup"],
} as Record<number | "default", string[]>;

export function getStatusPhrase(status: number): string {
  const key = status.toString() as keyof typeof PHRASES_BY_STATUS | "default";
  const phrases = PHRASES_BY_STATUS[key] || PHRASES_BY_STATUS.default;
  return phrases[Math.floor(Math.random() * phrases.length)];
}

function pickRandomEntry<T>(entries: readonly T[]): T {
  return entries[Math.floor(Math.random() * entries.length)];
}

export function getErrorReply(status: number, detail: string, personality: RouterPersonalityName): string {
  const { beginnings, holdings, invokes } = PERSONALITY_COLLECTIONS[personality];
  const beginning = pickRandomEntry(beginnings);
  const holding = pickRandomEntry(holdings);
  const invoke = pickRandomEntry(invokes);
  const message = `${beginning} ${getStatusPhrase(status)}. ${holding} ${invoke}`;
  return message + ` <!-- Upstream LLM ${status}: ${detail} -->`;
}
