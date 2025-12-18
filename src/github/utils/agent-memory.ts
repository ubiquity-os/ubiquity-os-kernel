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

type AgentMemoryDoc = Readonly<{
  version: 1;
  entries: AgentRunMemoryEntry[];
}>;

const MAX_ENTRIES = 50;
const SUMMARY_MAX_CHARS = 8_000;
const KV_TTL_MS = 45 * 24 * 60 * 60_000;

type KvKey = ReadonlyArray<unknown>;

type KvGetResult = Readonly<{ value: unknown }>;

type KvSetOptions = Readonly<{ expireIn?: number }>;

type KvLike = Readonly<{
  get: (key: KvKey) => Promise<KvGetResult>;
  set: (key: KvKey, value: unknown, options?: KvSetOptions) => Promise<unknown>;
}>;

const inMemory = new Map<string, AgentMemoryDoc>();
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
  return ["ubiquityos", "agent", "memory", owner, repo];
}

function buildMapKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function looksLikeKvLike(value: unknown): value is KvLike {
  if (!isRecord(value)) return false;
  return typeof value.get === "function" && typeof value.set === "function";
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

function parseDoc(value: unknown): AgentMemoryDoc {
  if (!isRecord(value)) return { version: 1, entries: [] };
  if (value.version !== 1) return { version: 1, entries: [] };
  const entriesRaw = Array.isArray(value.entries) ? value.entries : [];
  const entries: AgentRunMemoryEntry[] = [];
  for (const entry of entriesRaw) {
    if (!isRecord(entry) || entry.kind !== "agent_run") continue;
    const stateId = normalizeString(entry.stateId).trim();
    const status = normalizeString(entry.status).trim();
    const updatedAt = normalizeString(entry.updatedAt).trim();
    const issueNumber = typeof entry.issueNumber === "number" && Number.isFinite(entry.issueNumber) ? Math.trunc(entry.issueNumber) : null;
    if (!stateId || !status || !updatedAt || issueNumber === null) continue;
    entries.push({
      kind: "agent_run",
      stateId,
      status,
      issueNumber,
      updatedAt,
      runUrl: normalizeString(entry.runUrl).trim() || undefined,
      prUrl: normalizeString(entry.prUrl).trim() || undefined,
      summary: clampText(normalizeString(entry.summary), SUMMARY_MAX_CHARS) || undefined,
    });
  }
  return { version: 1, entries };
}

async function readDoc(owner: string, repo: string): Promise<AgentMemoryDoc> {
  const kv = await getKv();
  if (kv) {
    const result = await kv.get(buildKvKey(owner, repo));
    return parseDoc(result.value);
  }

  return inMemory.get(buildMapKey(owner, repo)) ?? { version: 1, entries: [] };
}

async function writeDoc(owner: string, repo: string, doc: AgentMemoryDoc): Promise<void> {
  const kv = await getKv();
  if (kv) {
    await kv.set(buildKvKey(owner, repo), doc, { expireIn: KV_TTL_MS });
    return;
  }
  inMemory.set(buildMapKey(owner, repo), doc);
}

function compareIsoDateStrings(a: string, b: string): number {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isFinite(aMs) && Number.isFinite(bMs)) return aMs - bMs;
  return a.localeCompare(b);
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
  const entry = params.entry;
  if (!owner || !repo) return;

  const doc = await readDoc(owner, repo);
  const nextEntries = [...doc.entries];
  const idx = nextEntries.findIndex((e) => e.kind === "agent_run" && e.stateId === entry.stateId);
  if (idx >= 0) nextEntries[idx] = entry;
  else nextEntries.push(entry);

  nextEntries.sort((a, b) => compareIsoDateStrings(a.updatedAt, b.updatedAt));
  while (nextEntries.length > MAX_ENTRIES) nextEntries.shift();

  await writeDoc(owner, repo, { version: 1, entries: nextEntries });
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

  const doc = await readDoc(owner, repo);
  if (doc.entries.length === 0) return "";

  const tail = doc.entries.slice(-limit).reverse();
  const lines: string[] = [];
  for (const e of tail) {
    const summaryFirstLine = (e.summary ?? "").split(/\r?\n/)[0]?.trim();
    const headline = summaryFirstLine ? clampText(summaryFirstLine, 180) : "";
    const parts = [`[${e.updatedAt}]`, `#${e.issueNumber}`, e.status];
    if (headline) parts.push(`— ${headline}`);
    lines.push(`- ${parts.join(" ")}`);
  }

  return clampText(lines.join("\n"), maxChars);
}
