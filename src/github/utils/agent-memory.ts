export type AgentRunMemoryEntry = Readonly<{
  kind: "agent_run";
  stateId: string;
  status: string;
  issueNumber: number;
  updatedAt: string;
  runUrl?: string;
  prUrl?: string;
  summary?: string;
}>;

type AgentMemoryEnvelope = Readonly<{
  v: 1;
  alg: "A256GCM";
  iv: string;
  data: string;
  codec: "json+gzip";
}>;

const SUMMARY_MAX_CHARS = 1_200;
const IN_MEMORY_MAX_ENTRIES = 250;
const LIST_PAGE_SIZE = 200;

import type { KvKey, KvLike, LoggerLike } from "./kv-client.ts";
import { getKvClient } from "./kv-client.ts";
import { getEnvValue } from "./env.ts";
import { parseAgentMemoryConfig } from "./env-config.ts";

const inMemory = new Map<string, AgentRunMemoryEntry[]>();
let kvPromise: Promise<KvLike | null> | null = null;
let memoryKeyPromise: Promise<CryptoKey | null> | null = null;
const warned = new Set<string>();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function warnOnce(logger: LoggerLike | undefined, key: string, message: string, err?: unknown) {
  if (!logger || typeof logger.warn !== "function" || warned.has(key)) return;
  warned.add(key);
  if (err !== undefined) {
    logger.warn({ err }, message);
  } else {
    logger.warn(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clampText(value: string, maxChars: number): string {
  const text = value.trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function normalizeBase64(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = normalized.length % 4;
  if (padLength === 0) return normalized;
  return `${normalized}${"=".repeat(4 - padLength)}`;
}

function decodeBase64Bytes(input: string): Uint8Array | null {
  const normalized = normalizeBase64(input);
  if (!normalized) return null;
  const atobFn = (globalThis as { atob?: (data: string) => string }).atob;
  if (typeof atobFn !== "function") return null;
  try {
    const binary = atobFn(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  const btoaFn = (globalThis as { btoa?: (data: string) => string }).btoa;
  if (typeof btoaFn !== "function") {
    throw new Error("btoa is unavailable");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoaFn(binary);
}

async function getMemoryCryptoKey(logger?: LoggerLike): Promise<CryptoKey | null> {
  if (memoryKeyPromise) return memoryKeyPromise;
  memoryKeyPromise = (async () => {
    const configResult = parseAgentMemoryConfig(getEnvValue("UOS_AGENT_MEMORY"));
    if (!configResult.ok) {
      warnOnce(logger, "agent-memory-config-invalid", configResult.error);
      return null;
    }
    const raw = configResult.config?.key;
    if (!raw) return null;
    const bytes = decodeBase64Bytes(raw);
    if (!bytes) {
      warnOnce(logger, "agent-memory-key-invalid", "UOS_AGENT_MEMORY.key must be base64-encoded 32 bytes.");
      return null;
    }
    if (bytes.length !== 32) {
      warnOnce(logger, "agent-memory-key-length", "UOS_AGENT_MEMORY.key must decode to 32 bytes for AES-256-GCM.");
      return null;
    }
    try {
      return await crypto.subtle.importKey("raw", toBufferSource(bytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    } catch (error) {
      warnOnce(logger, "agent-memory-key-import", "Failed to import UOS_AGENT_MEMORY.key.", error);
      return null;
    }
  })();
  return memoryKeyPromise;
}

async function compressBytes(payload: Uint8Array): Promise<Uint8Array> {
  const ctor = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!ctor) {
    throw new Error("CompressionStream is unavailable");
  }
  const stream = new ctor("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(toBufferSource(payload));
  await writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buffer);
}

async function decompressBytes(payload: Uint8Array): Promise<Uint8Array> {
  const ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!ctor) {
    throw new Error("DecompressionStream is unavailable");
  }
  const stream = new ctor("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(toBufferSource(payload));
  await writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buffer);
}

function isMemoryEnvelope(value: unknown): value is AgentMemoryEnvelope {
  if (!isRecord(value)) return false;
  return value.v === 1 && value.alg === "A256GCM" && value.codec === "json+gzip" && typeof value.iv === "string" && typeof value.data === "string";
}

async function encodeEntry(entry: AgentRunMemoryEntry, logger?: LoggerLike): Promise<AgentMemoryEnvelope | AgentRunMemoryEntry | null> {
  const key = await getMemoryCryptoKey(logger);
  if (!key) return entry;
  const compressed = await compressBytes(textEncoder.encode(JSON.stringify(entry)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ivSource = toBufferSource(iv);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivSource }, key, toBufferSource(compressed));
  return {
    v: 1,
    alg: "A256GCM",
    iv: encodeBase64Bytes(iv),
    data: encodeBase64Bytes(new Uint8Array(ciphertext)),
    codec: "json+gzip",
  };
}

async function decodeEntry(value: unknown, logger?: LoggerLike): Promise<AgentRunMemoryEntry | null> {
  if (isMemoryEnvelope(value)) {
    const key = await getMemoryCryptoKey(logger);
    if (!key) return null;

    const iv = decodeBase64Bytes(value.iv);
    const data = decodeBase64Bytes(value.data);
    if (!iv || !data) {
      warnOnce(logger, "agent-memory-envelope-base64", "Failed to decode agent memory payload.");
      return null;
    }
    try {
      const ivSource = toBufferSource(iv);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivSource }, key, toBufferSource(data));
      const decompressed = await decompressBytes(new Uint8Array(plaintext));
      const parsed = JSON.parse(textDecoder.decode(decompressed));
      return parseEntryRecord(parsed);
    } catch (error) {
      warnOnce(logger, "agent-memory-envelope-decrypt", "Failed to decrypt agent memory entry.", error);
      return null;
    }
  }
  return parseEntryRecord(value);
}

function normalizeScopeKey(scopeKey?: string): string {
  return typeof scopeKey === "string" ? scopeKey.trim() : "";
}

function buildKvKey(owner: string, repo: string, scopeKey?: string): KvKey {
  const scope = normalizeScopeKey(scopeKey);
  if (scope) return ["ubiquityos", "agent", "memory", "scope", scope, "events"];
  return ["ubiquityos", "agent", "memory", owner, repo, "events"];
}

function buildMapKey(owner: string, repo: string, scopeKey?: string): string {
  const scope = normalizeScopeKey(scopeKey);
  if (scope) return `scope:${scope}`;
  return `${owner}/${repo}`;
}

function buildEventKey(owner: string, repo: string, updatedAt: string, stateId: string, scopeKey?: string): KvKey {
  return [...buildKvKey(owner, repo, scopeKey), updatedAt, stateId];
}

async function getKv(logger?: LoggerLike): Promise<KvLike | null> {
  if (kvPromise) return kvPromise;
  kvPromise = getKvClient(logger);
  return kvPromise;
}

function parseEntryRecord(value: unknown): AgentRunMemoryEntry | null {
  if (!isRecord(value) || value.kind !== "agent_run") return null;
  const stateId = normalizeString(value.stateId).trim();
  const status = normalizeString(value.status).trim();
  const updatedAt = normalizeString(value.updatedAt).trim();
  const issueNumber = typeof value.issueNumber === "number" && Number.isFinite(value.issueNumber) ? Math.trunc(value.issueNumber) : null;
  if (!stateId || !status || !updatedAt || issueNumber === null) return null;
  return {
    kind: "agent_run",
    stateId,
    status,
    issueNumber,
    updatedAt,
    runUrl: normalizeString(value.runUrl).trim() || undefined,
    prUrl: normalizeString(value.prUrl).trim() || undefined,
    summary: clampText(normalizeString(value.summary), SUMMARY_MAX_CHARS) || undefined,
  };
}

function sanitizeEntry(value: AgentRunMemoryEntry): AgentRunMemoryEntry | null {
  return parseEntryRecord(value);
}

async function readEntriesFromKv(
  kv: KvLike,
  owner: string,
  repo: string,
  limit: number,
  logger?: LoggerLike,
  scopeKey?: string
): Promise<AgentRunMemoryEntry[]> {
  const scanLimit = Math.max(limit * 12, limit);
  const prefix = buildKvKey(owner, repo, scopeKey);
  const entries: AgentRunMemoryEntry[] = [];

  if (kv.supportsReverse !== false) {
    try {
      for await (const item of kv.list({ prefix }, { reverse: true, limit: scanLimit })) {
        const parsed = await decodeEntry(item.value, logger);
        if (parsed) entries.push(parsed);
      }
      return entries;
    } catch (error) {
      warnOnce(logger, "agent-memory-list", "Failed to list agent memory entries.", error);
      return [];
    }
  }

  const buffer: AgentRunMemoryEntry[] = [];
  let cursor: string | undefined;
  try {
    do {
      const iterator = kv.list({ prefix }, { limit: LIST_PAGE_SIZE, cursor });
      for await (const item of iterator) {
        const parsed = await decodeEntry(item.value, logger);
        if (!parsed) continue;
        buffer.push(parsed);
        if (buffer.length > scanLimit) buffer.shift();
      }
      cursor = iterator.cursor ? String(iterator.cursor) : "";
    } while (cursor);
  } catch (error) {
    warnOnce(logger, "agent-memory-list", "Failed to list agent memory entries.", error);
    return [];
  }

  buffer.reverse();
  return buffer;
}

async function upsertAgentRunMemoryScope(
  params: Readonly<{
    owner: string;
    repo: string;
    entry: AgentRunMemoryEntry;
    logger?: LoggerLike;
    scopeKey?: string;
  }>
): Promise<void> {
  const owner = params.owner.trim();
  const repo = params.repo.trim();
  const entry = sanitizeEntry(params.entry);
  if (!owner || !repo) return;
  if (!entry) return;

  const kv = await getKv(params.logger);
  if (kv) {
    try {
      const encoded = await encodeEntry(entry, params.logger);
      if (encoded) {
        await kv.set(buildEventKey(owner, repo, entry.updatedAt, entry.stateId, params.scopeKey), encoded);
        return;
      }
    } catch (error) {
      warnOnce(params.logger, "agent-memory-write", "Failed to persist agent memory entry.", error);
    }
  }

  const key = buildMapKey(owner, repo, params.scopeKey);
  const entries = inMemory.get(key) ?? [];
  entries.push(entry);
  while (entries.length > IN_MEMORY_MAX_ENTRIES) entries.shift();
  inMemory.set(key, entries);
}

export async function upsertAgentRunMemory(
  params: Readonly<{
    owner: string;
    repo: string;
    entry: AgentRunMemoryEntry;
    logger?: LoggerLike;
    scopeKey?: string;
  }>
): Promise<void> {
  await upsertAgentRunMemoryScope(params);
  const scope = normalizeScopeKey(params.scopeKey);
  if (scope) {
    await upsertAgentRunMemoryScope({ ...params, scopeKey: undefined });
  }
}

export async function getAgentMemorySnippet(
  params: Readonly<{
    owner: string;
    repo: string;
    limit?: number;
    maxChars?: number;
    logger?: LoggerLike;
    scopeKey?: string;
  }>
): Promise<string> {
  const owner = params.owner.trim();
  const repo = params.repo.trim();
  const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(0, Math.trunc(params.limit)) : 6;
  const maxChars = typeof params.maxChars === "number" && Number.isFinite(params.maxChars) ? Math.max(200, Math.trunc(params.maxChars)) : 2_000;
  if (!owner || !repo || limit === 0) return "";

  const entriesForSnippet = await collectAgentMemoryEntries({
    owner,
    repo,
    logger: params.logger,
    scopeKey: params.scopeKey,
    limit,
  });
  if (entriesForSnippet.length === 0) return "";

  const lines = entriesForSnippet.map((entry) => {
    const summaryFirstLine = (entry.summary ?? "").split(/\r?\n/)[0]?.trim();
    const headline = summaryFirstLine ? clampText(summaryFirstLine, 180) : "";
    const parts = [`[${entry.updatedAt}]`, `#${entry.issueNumber}`, entry.status];
    if (headline) parts.push(`- ${headline}`);
    return `- ${parts.join(" ")}`;
  });

  return clampText(lines.join("\n"), maxChars);
}

type AgentMemoryEntriesParams = Readonly<{
  owner: string;
  repo: string;
  limit?: number;
  logger?: LoggerLike;
  scopeKey?: string;
}>;

const DEFAULT_LIST_LIMIT = 50;

async function collectAgentMemoryEntries(params: AgentMemoryEntriesParams): Promise<AgentRunMemoryEntry[]> {
  const owner = params.owner.trim();
  const repo = params.repo.trim();
  const limit = typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0 ? Math.trunc(params.limit) : 0;
  if (!owner || !repo || limit === 0) return [];

  const kv = await getKv(params.logger);
  const entries: AgentRunMemoryEntry[] = [];
  const scope = normalizeScopeKey(params.scopeKey);

  if (kv) {
    entries.push(...(await readEntriesFromKv(kv, owner, repo, limit, params.logger, scope || undefined)));
  }

  const key = buildMapKey(owner, repo, scope || undefined);
  const localEntries = inMemory.get(key) ?? [];
  if (localEntries.length > 0) {
    entries.push(...localEntries.slice(-IN_MEMORY_MAX_ENTRIES).reverse());
  }

  if (entries.length === 0 && scope) {
    if (kv) {
      entries.push(...(await readEntriesFromKv(kv, owner, repo, limit, params.logger)));
    }
    const repoKey = buildMapKey(owner, repo);
    const repoEntries = inMemory.get(repoKey) ?? [];
    if (repoEntries.length > 0) {
      entries.push(...repoEntries.slice(-IN_MEMORY_MAX_ENTRIES).reverse());
    }
  }

  if (entries.length === 0) return [];

  const seen = new Set<string>();
  const output: AgentRunMemoryEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.stateId)) continue;
    seen.add(entry.stateId);
    output.push(entry);
    if (output.length >= limit) break;
  }

  return output;
}

export async function listAgentMemoryEntries(params: AgentMemoryEntriesParams): Promise<AgentRunMemoryEntry[]> {
  return collectAgentMemoryEntries({ ...params, limit: params.limit ?? DEFAULT_LIST_LIMIT });
}
