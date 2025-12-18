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

const SUMMARY_MAX_CHARS = 1_200;
const IN_MEMORY_MAX_ENTRIES = 250;

type KvKey = ReadonlyArray<unknown>;

type KvGetResult = Readonly<{ value: unknown }>;

type KvSetOptions = Readonly<{ expireIn?: number }>;

type KvListEntry = Readonly<{ key: KvKey; value: unknown }>;

type KvListOptions = Readonly<{ reverse?: boolean; limit?: number; cursor?: string; batchSize?: number }>;

type KvListSelector = Readonly<{ prefix: KvKey }>;

type KvLike = Readonly<{
  get: (key: KvKey) => Promise<KvGetResult>;
  set: (key: KvKey, value: unknown, options?: KvSetOptions) => Promise<unknown>;
  list: (selector: KvListSelector, options?: KvListOptions) => AsyncIterable<KvListEntry>;
}>;

const inMemory = new Map<string, AgentRunMemoryEntry[]>();
let kvPromise: Promise<KvLike | null> | null = null;

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

async function getKv(): Promise<KvLike | null> {
  if (kvPromise) return kvPromise;
  kvPromise = (async () => {
    const deno = (globalThis as unknown as { Deno?: { openKv?: () => Promise<unknown> } }).Deno;
    if (!deno || typeof deno.openKv !== "function") return null;
    try {
      const kv = await deno.openKv();
      return looksLikeKvLike(kv) ? kv : null;
    } catch {
      return null;
    }
  })();
  return kvPromise;
}

function parseEntry(value: unknown): AgentRunMemoryEntry | null {
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
  return parseEntry(value);
}

export async function upsertAgentRunMemory(
  params: Readonly<{
    owner: string;
    repo: string;
    entry: AgentRunMemoryEntry;
  }>
): Promise<void> {
  const owner = params.owner.trim();
  const repo = params.repo.trim();
  const entry = sanitizeEntry(params.entry);
  if (!owner || !repo) return;
  if (!entry) return;

  const kv = await getKv();
  if (kv) {
    await kv.set(buildEventKey(owner, repo, entry.updatedAt, entry.stateId), entry);
    return;
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
  }>
): Promise<string> {
  const owner = params.owner.trim();
  const repo = params.repo.trim();
  const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(0, Math.trunc(params.limit)) : 6;
  const maxChars = typeof params.maxChars === "number" && Number.isFinite(params.maxChars) ? Math.max(200, Math.trunc(params.maxChars)) : 2_000;
  if (!owner || !repo || limit === 0) return "";

  const kv = await getKv();
  const entries: AgentRunMemoryEntry[] = [];

  if (kv) {
    const scanLimit = Math.max(limit * 12, limit);
    for await (const item of kv.list({ prefix: buildKvKey(owner, repo) }, { reverse: true, limit: scanLimit })) {
      const parsed = parseEntry(item.value);
      if (parsed) entries.push(parsed);
    }
  } else {
    const key = buildMapKey(owner, repo);
    entries.push(...(inMemory.get(key) ?? []).slice(-IN_MEMORY_MAX_ENTRIES).reverse());
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
    if (headline) parts.push(`— ${headline}`);
    lines.push(`- ${parts.join(" ")}`);
    if (lines.length >= limit) break;
  }

  return clampText(lines.join("\n"), maxChars);
}
