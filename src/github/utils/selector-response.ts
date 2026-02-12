import { GitHubContext } from "../github-context.ts";
import { callUbqAiRouter } from "./ai-router.ts";
import type { LoggerLike } from "./kv-client.ts";

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

export function parseIncludeIdsSelectionResponse(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const snippet = extractJsonObject(trimmed);
    if (!snippet) return null;
    try {
      parsed = JSON.parse(snippet);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") return null;
  const includeIdsRaw = (parsed as { includeIds?: unknown }).includeIds;
  if (!Array.isArray(includeIdsRaw)) return null;
  return includeIdsRaw.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean);
}

function chunkArray<T>(values: T[], size: number): T[][] {
  if (size <= 0 || values.length === 0) return [values];
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

type SelectIncludeIdsWithRouterParams<TCandidate> = Readonly<{
  context: GitHubContext;
  query: string;
  prompt: string;
  candidates: TCandidate[];
  candidateId: (candidate: TCandidate) => string;
  buildRouterInput: (batch: TCandidate[]) => unknown;
  maxSelections: number;
  timeoutMs: number;
  batchSize?: number;
  maxCandidates?: number;
  logger?: LoggerLike;
  parseFailureMessage?: string;
  callFailureMessage?: string;
}>;

export async function selectIncludeIdsWithRouter<TCandidate>(params: SelectIncludeIdsWithRouterParams<TCandidate>): Promise<Set<string> | null> {
  const query = params.query.trim();
  if (!query) return null;
  if (!params.context?.eventHandler) return null;
  const payload = params.context.payload as Record<string, unknown>;
  const installation = (payload.installation as { id?: number } | undefined) ?? null;
  if (!installation?.id) return null;

  const maxCandidates =
    typeof params.maxCandidates === "number" && Number.isFinite(params.maxCandidates)
      ? Math.max(1, Math.trunc(params.maxCandidates))
      : params.candidates.length;
  const candidates = params.candidates.slice(0, maxCandidates);
  const allowed = new Set(candidates.map((candidate) => params.candidateId(candidate)).filter(Boolean));
  if (allowed.size === 0) return new Set<string>();

  const maxSelections = Math.max(1, Math.trunc(params.maxSelections));
  const batchSize = typeof params.batchSize === "number" && Number.isFinite(params.batchSize) ? Math.max(1, Math.trunc(params.batchSize)) : candidates.length;
  const batches = chunkArray(candidates, batchSize);
  const selected: string[] = [];
  const seen = new Set<string>();
  const logger = params.logger ?? params.context.logger;
  for (const batch of batches) {
    try {
      const raw = await callUbqAiRouter(params.context, params.prompt, params.buildRouterInput(batch), { timeoutMs: params.timeoutMs });
      const includeIds = parseIncludeIdsSelectionResponse(raw);
      if (!includeIds) {
        logger?.debug?.(params.parseFailureMessage ?? "Include-ids selector response did not parse");
        continue;
      }
      for (const id of includeIds) {
        const trimmed = id.trim();
        if (!trimmed || seen.has(trimmed) || !allowed.has(trimmed)) continue;
        seen.add(trimmed);
        selected.push(trimmed);
      }
    } catch (error) {
      logger?.warn?.({ err: error }, params.callFailureMessage ?? "Include-ids selector call failed");
    }
  }

  return new Set(selected.slice(0, maxSelections));
}
