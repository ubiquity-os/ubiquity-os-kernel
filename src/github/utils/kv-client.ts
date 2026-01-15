import { getEnvValue } from "./env.ts";
import { parseAgentMemoryConfig } from "./env-config.ts";

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

let kvClientPromise: Promise<KvLike | null> | null = null;

function resolveKvUrl(logger?: LoggerLike): string | null {
  const configResult = parseAgentMemoryConfig(getEnvValue("UOS_AGENT_MEMORY"));
  if (!configResult.ok) {
    if (logger?.warn) logger.warn({ err: configResult.error }, "Invalid UOS_AGENT_MEMORY config.");
    return null;
  }
  const raw = configResult.config?.url;
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  return trimmed.endsWith("/kv") ? trimmed : `${trimmed}/kv`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
      const hasValue = Object.prototype.hasOwnProperty.call(response, "value");
      return { value: hasValue ? response.value : null };
    },
    async set(key: KvKey, value: unknown, options?: KvSetOptions) {
      const url = `${base}/${buildKeyPath(key)}`;
      const payload: { value: unknown; expireIn?: number } = { value };
      if (options?.expireIn !== undefined) payload.expireIn = options.expireIn;
      await fetchJson(url, { method: "POST", body: JSON.stringify(payload) });
      return null;
    },
    list(selector: KvListSelector, options: KvListOptions = {}) {
      if (options.reverse) {
        throw new Error("Pi KV does not support reverse iteration");
      }
      // Note: Pi KV list returns a single page; use iterator.cursor to paginate.
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

export async function getKvClient(logger?: LoggerLike): Promise<KvLike | null> {
  if (kvClientPromise) return kvClientPromise;
  kvClientPromise = (async () => {
    const memoryUrl = resolveKvUrl(logger);
    if (memoryUrl) {
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
    } catch (error) {
      if (logger?.debug) logger.debug({ err: error }, "Failed to open Deno KV (non-fatal)");
      return null;
    }
  })();
  return kvClientPromise;
}

export type { KvKey, KvGetResult, KvLike, KvListEntry, KvListIterator, KvListOptions, KvListSelector, KvSetOptions, LoggerLike };
