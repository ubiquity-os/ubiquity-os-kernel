type AgentRunMemoryEntry = Readonly<{
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

type KvKey = ReadonlyArray<unknown>;

type KvGetResult = Readonly<{ value: unknown }>;

type KvSetOptions = Readonly<{ expireIn?: number }>;

type KvListEntry = Readonly<{ key: KvKey; value: unknown }>;

type KvListOptions = Readonly<{ reverse?: boolean; limit?: number; cursor?: string }>;

type KvListSelector = Readonly<{ prefix: KvKey }>;

type KvListIterator = AsyncIterable<KvListEntry> & { cursor?: string };

type KvLike = Readonly<{
  get: (key: KvKey) => Promise<KvGetResult>;
  set: (key: KvKey, value: unknown, options?: KvSetOptions) => Promise<unknown>;
  list: (selector: KvListSelector, options?: KvListOptions) => KvListIterator;
  supportsReverse?: boolean;
}>;

type LoggerLike = Readonly<{
  warn?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}>;

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
  return `${text.slice(0, maxChars)}…`;
}

function getEnvValue(key: string): string | undefined {
  if (typeof process !== "undefined" && process.env) {
    const value = process.env[key];
    if (value !== undefined) return value;
  }
  const deno = (globalThis as { Deno?: { env?: { get?: (key: string) => string | undefined } } }).Deno;
  if (deno?.env?.get) return deno.env.get(key);
  return undefined;
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

function resolveMemoryUrl(): string | null {
  const raw = getEnvValue("UOS_AGENT_MEMORY_URL");
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  return trimmed.endsWith("/kv") ? trimmed : `${trimmed}/kv`;
}

async function getMemoryCryptoKey(logger?: LoggerLike): Promise<CryptoKey | null> {
  if (memoryKeyPromise) return memoryKeyPromise;
  memoryKeyPromise = (async () => {
    const raw = getEnvValue("UOS_AGENT_MEMORY_KEY");
    if (!raw) {
      warnOnce(logger, "agent-memory-key-missing", "UOS_AGENT_MEMORY_KEY is not set; agent memory persistence is disabled.");
      return null;
    }
    const bytes = decodeBase64Bytes(raw);
    if (!bytes) {
      warnOnce(logger, "agent-memory-key-invalid", "UOS_AGENT_MEMORY_KEY must be base64-encoded 32 bytes.");
      return null;
    }
    if (bytes.length !== 32) {
      warnOnce(logger, "agent-memory-key-length", "UOS_AGENT_MEMORY_KEY must decode to 32 bytes for AES-256-GCM.");
      return null;
    }
    try {
      return await crypto.subtle.importKey("raw", toBufferSource(bytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    } catch (error) {
      warnOnce(logger, "agent-memory-key-import", "Failed to import UOS_AGENT_MEMORY_KEY.", error);
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

async function encodeEntry(entry: AgentRunMemoryEntry, logger?: LoggerLike): Promise<AgentMemoryEnvelope | null> {
  const key = await getMemoryCryptoKey(logger);
  if (!key) return null;
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

function buildKvKey(owner: string, repo: string): KvKey {
  return ["ubiquityos", "agent", "memory", owner, repo, "events"];
}

function buildMapKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function buildEventKey(owner: string, repo: string, updatedAt: string, stateId: string): KvKey {
  return [...buildKvKey(owner, repo), updatedAt, stateId];
}

function looksLikeKvLike(value: unknown): value is KvLike {
  if (!isRecord(value)) return false;
  return typeof value.get === "function" && typeof value.set === "function" && typeof value.list === "function";
}

function encodeKeyPart(part: unknown): string {
  if (typeof part === "string") return part;
  if (typeof part === "number" || typeof part === "bigint") return String(part);
  if (typeof part === "boolean") return part ? "true" : "false";
  return String(part);
}

function buildKeyPath(key: KvKey): string {
  return key.map((part) => encodeURIComponent(encodeKeyPart(part))).join("/");
}

function createPiKvClient(baseUrl: string): KvLike {
  const base = baseUrl.replace(/\/+$/, "");

  async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Pi KV request failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  return {
    supportsReverse: false,
    async get(key: KvKey) {
      const url = `${base}/${buildKeyPath(key)}`;
      const response = await fetchJson<{ value?: unknown }>(url, { method: "GET" });
      return { value: response.value ?? null };
    },
    async set(key: KvKey, value: unknown, options?: KvSetOptions) {
      const url = `${base}/${buildKeyPath(key)}`;
      const payload: { value: unknown; expireIn?: number } = { value };
      if (options?.expireIn !== undefined) payload.expireIn = options.expireIn;
      await fetchJson(url, { method: "POST", body: JSON.stringify(payload) });
      return null;
    },
    list(selector: KvListSelector, options: KvListOptions = {}) {
      const payload = {
        prefix: selector.prefix,
        limit: options.limit,
        cursor: options.cursor,
      };
      const url = `${base}/list`;
      const iterator: KvListIterator = {
        cursor: "",
        async *[Symbol.asyncIterator]() {
          const response = await fetchJson<{ entries?: KvListEntry[]; cursor?: string | null }>(url, {
            method: "POST",
            body: JSON.stringify(payload),
          });
          iterator.cursor = response.cursor ?? "";
          for (const entry of response.entries ?? []) {
            yield { key: entry.key, value: entry.value };
          }
        },
      };
      return iterator;
    },
  };
}

async function getKv(logger?: LoggerLike): Promise<KvLike | null> {
  if (kvPromise) return kvPromise;
  kvPromise = (async () => {
    const memoryUrl = resolveMemoryUrl();
    if (memoryUrl) {
      const key = await getMemoryCryptoKey(logger);
      if (!key) return null;
      return createPiKvClient(memoryUrl);
    }

    const deno = (globalThis as unknown as { Deno?: { openKv?: () => Promise<unknown> } }).Deno;
    if (!deno || typeof deno.openKv !== "function") return null;
    try {
      const kv = await deno.openKv();
      if (!looksLikeKvLike(kv)) return null;
      return {
        get: kv.get.bind(kv),
        set: kv.set.bind(kv),
        list: kv.list.bind(kv),
        supportsReverse: true,
      };
    } catch {
      return null;
    }
  })();
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

async function readEntriesFromKv(kv: KvLike, owner: string, repo: string, limit: number, logger?: LoggerLike): Promise<AgentRunMemoryEntry[]> {
  const scanLimit = Math.max(limit * 12, limit);
  const prefix = buildKvKey(owner, repo);
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

export async function upsertAgentRunMemory(
  params: Readonly<{
    owner: string;
    repo: string;
    entry: AgentRunMemoryEntry;
    logger?: LoggerLike;
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
        await kv.set(buildEventKey(owner, repo, entry.updatedAt, entry.stateId), encoded);
        return;
      }
    } catch (error) {
      warnOnce(params.logger, "agent-memory-write", "Failed to persist agent memory entry.", error);
    }
  }

  const key = buildMapKey(owner, repo);
  const entries = inMemory.get(key) ?? [];
  entries.push(entry);
  while (entries.length > IN_MEMORY_MAX_ENTRIES) entries.shift();
  inMemory.set(key, entries);
}

export async function getAgentMemorySnippet(
  params: Readonly<{
    owner: string;
    repo: string;
    limit?: number;
    maxChars?: number;
    logger?: LoggerLike;
  }>
): Promise<string> {
  const owner = params.owner.trim();
  const repo = params.repo.trim();
  const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(0, Math.trunc(params.limit)) : 6;
  const maxChars = typeof params.maxChars === "number" && Number.isFinite(params.maxChars) ? Math.max(200, Math.trunc(params.maxChars)) : 2_000;
  if (!owner || !repo || limit === 0) return "";

  const kv = await getKv(params.logger);
  const entries: AgentRunMemoryEntry[] = [];

  if (kv) {
    entries.push(...(await readEntriesFromKv(kv, owner, repo, limit, params.logger)));
  }

  const key = buildMapKey(owner, repo);
  const localEntries = inMemory.get(key) ?? [];
  if (localEntries.length > 0) {
    entries.push(...localEntries.slice(-IN_MEMORY_MAX_ENTRIES).reverse());
  }

  if (entries.length === 0) return "";

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const e of entries) {
    if (seen.has(e.stateId)) continue;
    seen.add(e.stateId);
    const summaryFirstLine = (e.summary ?? "").split(/\r?\n/)[0]?.trim();
    const headline = summaryFirstLine ? clampText(summaryFirstLine, 180) : "";
    const parts = [`[${e.updatedAt}]`, `#${e.issueNumber}`, e.status];
    if (headline) parts.push(`- ${headline}`);
    lines.push(`- ${parts.join(" ")}`);
    if (lines.length >= limit) break;
  }

  return clampText(lines.join("\n"), maxChars);
}
