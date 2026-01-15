export type ParseResult<T> = { ok: true; config: T } | { ok: false; error: string };
export type OptionalParseResult<T> = { ok: true; config: T | null; warning?: string } | { ok: false; error: string };

export type AiConfig = Readonly<{
  baseUrl: string;
  token?: string;
}>;

export type AgentConfig = Readonly<{
  owner: string;
  repo: string;
  workflow: string;
  ref?: string;
}>;

export type KernelConfig = Readonly<{
  refreshIntervalSeconds?: number;
}>;

export type AgentMemoryConfig = Readonly<{
  url?: string;
  key?: string;
}>;

export type DiagnosticsConfig = Readonly<{
  token: string;
}>;

export type SupabaseConfig = Readonly<{
  url: string;
  anonKey: string;
}>;

const DEFAULT_AI_BASE_URL = "https://ai-ubq-fi.deno.dev";
const DEFAULT_AGENT_OWNER = "ubiquity-os";
const DEFAULT_AGENT_REPO = "ubiquity-os-kernel";
const DEFAULT_AGENT_WORKFLOW = "agent.yml";

export function parseAiConfig(raw?: string | null): ParseResult<AiConfig> {
  const trimmed = normalizeRaw(raw);
  if (!trimmed) {
    return { ok: true, config: { baseUrl: DEFAULT_AI_BASE_URL } };
  }
  const parsed = parseJsonRecord(trimmed, "UOS_AI");
  if (!parsed.ok) return parsed;
  const record = parsed.record;
  const baseUrl = normalizeOptionalString(record.baseUrl) ?? DEFAULT_AI_BASE_URL;
  const token = normalizeOptionalString(record.token);
  return {
    ok: true,
    config: {
      baseUrl,
      ...(token ? { token } : {}),
    },
  };
}

export function parseAgentConfig(raw?: string | null): ParseResult<AgentConfig> {
  const trimmed = normalizeRaw(raw);
  if (!trimmed) {
    return {
      ok: true,
      config: {
        owner: DEFAULT_AGENT_OWNER,
        repo: DEFAULT_AGENT_REPO,
        workflow: DEFAULT_AGENT_WORKFLOW,
      },
    };
  }
  const parsed = parseJsonRecord(trimmed, "UOS_AGENT");
  if (!parsed.ok) return parsed;
  const record = parsed.record;
  const owner = normalizeOptionalString(record.owner) ?? DEFAULT_AGENT_OWNER;
  const repo = normalizeOptionalString(record.repo) ?? DEFAULT_AGENT_REPO;
  const workflow = normalizeOptionalString(record.workflow) ?? DEFAULT_AGENT_WORKFLOW;
  const ref = normalizeOptionalString(record.ref);
  return {
    ok: true,
    config: {
      owner,
      repo,
      workflow,
      ...(ref ? { ref } : {}),
    },
  };
}

export function parseKernelConfig(raw?: string | null): ParseResult<KernelConfig> {
  const trimmed = normalizeRaw(raw);
  if (!trimmed) {
    return { ok: true, config: {} };
  }
  const parsed = parseJsonRecord(trimmed, "UOS_KERNEL");
  if (!parsed.ok) return parsed;
  const record = parsed.record;
  const refreshIntervalSeconds = normalizeOptionalNumber(record.refreshIntervalSeconds);
  return {
    ok: true,
    config: {
      ...(refreshIntervalSeconds !== undefined ? { refreshIntervalSeconds } : {}),
    },
  };
}

export function parseAgentMemoryConfig(raw?: string | null): OptionalParseResult<AgentMemoryConfig> {
  const trimmed = normalizeRaw(raw);
  if (!trimmed) {
    return { ok: true, config: null };
  }
  const parsed = parseJsonRecord(trimmed, "UOS_AGENT_MEMORY");
  if (!parsed.ok) return parsed;
  const record = parsed.record;
  const url = normalizeOptionalString(record.url);
  const key = normalizeOptionalString(record.key);
  if (!url && !key) {
    return { ok: true, config: null };
  }
  return {
    ok: true,
    config: {
      ...(url ? { url } : {}),
      ...(key ? { key } : {}),
    },
  };
}

export function parseDiagnosticsConfig(raw?: string | null): OptionalParseResult<DiagnosticsConfig> {
  const trimmed = normalizeRaw(raw);
  if (!trimmed) {
    return { ok: true, config: null };
  }
  const parsed = parseJsonRecord(trimmed, "UOS_DIAGNOSTICS");
  if (!parsed.ok) return parsed;
  const record = parsed.record;
  const token = normalizeOptionalString(record.token);
  if (!token) {
    return { ok: true, config: null, warning: "UOS_DIAGNOSTICS.token is required." };
  }
  return { ok: true, config: { token } };
}

export function parseSupabaseConfig(raw?: string | null): OptionalParseResult<SupabaseConfig> {
  const trimmed = normalizeRaw(raw);
  if (!trimmed) {
    return { ok: true, config: null };
  }
  const parsed = parseJsonRecord(trimmed, "UOS_SUPABASE");
  if (!parsed.ok) return parsed;
  const record = parsed.record;
  const url = normalizeOptionalString(record.url);
  const anonKey = normalizeOptionalString(record.anonKey);
  if (!url || !anonKey) {
    return {
      ok: true,
      config: null,
      warning: "UOS_SUPABASE.url and UOS_SUPABASE.anonKey are required.",
    };
  }
  return {
    ok: true,
    config: {
      url: url.replace(/\/+$/, ""),
      anonKey,
    },
  };
}

function normalizeRaw(value?: string | null): string {
  return value?.trim() ?? "";
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseJsonRecord(raw: string, label: string): { ok: true; record: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: `Invalid ${label} JSON.` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `Invalid ${label} config.` };
  }
  return { ok: true, record: parsed as Record<string, unknown> };
}
