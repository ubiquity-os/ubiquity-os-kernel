type KvKey = ReadonlyArray<unknown>;

type KvGetResult = Readonly<{ value: unknown; versionstamp?: string | null }>;

type KvSetOptions = Readonly<{ expireIn?: number }>;

type KvListEntry = Readonly<{ key: KvKey; value: unknown }>;

type KvListOptions = Readonly<{ reverse?: boolean; limit?: number; cursor?: string }>;

type KvListSelector = Readonly<{ prefix: KvKey }>;

type KvListIterator = AsyncIterable<KvListEntry> & { cursor?: string };

type KvAtomicCheck = Readonly<{ key: KvKey; versionstamp: string | null }>;

type KvAtomicOperation = Readonly<{
  check: (check: KvAtomicCheck) => KvAtomicOperation;
  set: (key: KvKey, value: unknown, options?: KvSetOptions) => KvAtomicOperation;
  delete: (key: KvKey) => KvAtomicOperation;
  commit: () => Promise<{ ok: boolean }>;
}>;

type KvLike = Readonly<{
  get: (key: KvKey) => Promise<KvGetResult>;
  set: (key: KvKey, value: unknown, options?: KvSetOptions) => Promise<unknown>;
  delete?: (key: KvKey) => Promise<unknown>;
  list: (selector: KvListSelector, options?: KvListOptions) => KvListIterator;
  atomic?: () => KvAtomicOperation;
  supportsReverse?: boolean;
}>;

type LoggerLike = Readonly<{
  warn?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function looksLikeKvLike(value: unknown): value is KvLike {
  if (!isRecord(value)) return false;
  return typeof value.get === "function" && typeof value.set === "function" && typeof value.list === "function";
}

export async function getKvClient(logger?: LoggerLike): Promise<KvLike | null> {
  const deno = (globalThis as unknown as { Deno?: { openKv?: () => Promise<unknown> } }).Deno;
  if (!deno || typeof deno.openKv !== "function") return null;
  try {
    const kv = await deno.openKv();
    if (!looksLikeKvLike(kv)) return null;
    return {
      get: kv.get.bind(kv),
      set: kv.set.bind(kv),
      delete: typeof kv.delete === "function" ? kv.delete.bind(kv) : undefined,
      list: kv.list.bind(kv),
      atomic: typeof kv.atomic === "function" ? kv.atomic.bind(kv) : undefined,
      supportsReverse: true,
    };
  } catch (error) {
    if (logger?.debug) logger.debug({ err: error }, "Failed to open Deno KV (non-fatal)");
    return null;
  }
}

export type { KvKey, KvGetResult, KvLike, KvListEntry, KvListIterator, KvListOptions, KvListSelector, KvSetOptions, LoggerLike };
