import { GitHubContext } from "../github-context.ts";
import { type AgentRunMemoryEntry, listAgentMemoryEntries } from "./agent-memory.ts";
import type { LoggerLike } from "./kv-client.ts";
import { selectIncludeIdsWithRouter } from "./selector-response.ts";

const DEFAULT_SNIPPET_LIMIT = 6;
const DEFAULT_SNIPPET_MAX_CHARS = 2_000;
const DEFAULT_SELECTOR_CANDIDATE_LIMIT = 24;
const DEFAULT_SELECTOR_TIMEOUT_MS = 15_000;

function clampText(value: string, maxChars: number): string {
  const text = value.trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function normalizeFirstLine(value: string | undefined, maxChars: number): string {
  const first =
    String(value ?? "")
      .split(/\r?\n/)[0]
      ?.trim() ?? "";
  return first ? clampText(first, maxChars) : "";
}

function formatAgentMemorySnippet(entries: AgentRunMemoryEntry[], maxChars: number): string {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => {
    const headline = normalizeFirstLine(entry.summary, 180);
    const parts = [`[${entry.updatedAt}]`, `#${entry.issueNumber}`, entry.status];
    if (headline) parts.push(`- ${headline}`);
    return `- ${parts.join(" ")}`;
  });
  return clampText(lines.join("\n"), maxChars);
}

function buildAgentMemorySelectorPrompt(maxSelections: number): string {
  return `
You are a context selector for prior agent-run memory.

Return ONLY JSON with this shape:
{ "includeIds": ["..."] }

Rules:
- Use ONLY IDs from the provided candidates list.
- Choose the minimal set needed to help with the query.
- Prefer entries that are directly relevant and recent.
- Return at most ${maxSelections} IDs.
- If no candidate is relevant, return an empty array.
`.trim();
}

async function selectRelevantAgentMemoryIds(params: {
  context: GitHubContext;
  query: string;
  candidates: AgentRunMemoryEntry[];
  maxSelections: number;
  logger?: LoggerLike;
}): Promise<Set<string> | null> {
  const query = params.query.trim();
  if (!query) return null;
  return await selectIncludeIdsWithRouter({
    context: params.context,
    query,
    prompt: buildAgentMemorySelectorPrompt(params.maxSelections),
    candidates: params.candidates,
    candidateId: (candidate) => candidate.stateId,
    buildRouterInput: (batch) => ({
      query,
      candidates: batch.map((entry) => ({
        id: entry.stateId,
        updatedAt: entry.updatedAt,
        issueNumber: entry.issueNumber,
        status: entry.status,
        summary: normalizeFirstLine(entry.summary, 500),
        runUrl: entry.runUrl ?? "",
        prUrl: entry.prUrl ?? "",
      })),
    }),
    maxSelections: params.maxSelections,
    timeoutMs: DEFAULT_SELECTOR_TIMEOUT_MS,
    logger: params.logger,
    parseFailureMessage: "Agent memory selector response did not parse",
    callFailureMessage: "Agent memory selector failed (non-fatal)",
  });
}

export async function getAgentMemorySnippetForQuery(
  params: Readonly<{
    context: GitHubContext;
    owner: string;
    repo: string;
    query?: string;
    limit?: number;
    maxChars?: number;
    logger?: LoggerLike;
    scopeKey?: string;
  }>
): Promise<string> {
  const owner = params.owner.trim();
  const repo = params.repo.trim();
  const query = String(params.query ?? "").trim();
  const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(0, Math.trunc(params.limit)) : DEFAULT_SNIPPET_LIMIT;
  const maxChars =
    typeof params.maxChars === "number" && Number.isFinite(params.maxChars) ? Math.max(200, Math.trunc(params.maxChars)) : DEFAULT_SNIPPET_MAX_CHARS;
  if (!owner || !repo || limit === 0) return "";

  const candidateLimit = Math.max(DEFAULT_SELECTOR_CANDIDATE_LIMIT, limit * 4);
  const candidates = await listAgentMemoryEntries({
    owner,
    repo,
    scopeKey: params.scopeKey,
    limit: candidateLimit,
    logger: params.logger,
  });
  if (candidates.length === 0) return "";

  if (!query) {
    return formatAgentMemorySnippet(candidates.slice(0, limit), maxChars);
  }

  const selectedIds = await selectRelevantAgentMemoryIds({
    context: params.context,
    query,
    candidates,
    maxSelections: limit,
    logger: params.logger,
  });
  if (!selectedIds || selectedIds.size === 0) {
    return formatAgentMemorySnippet(candidates.slice(0, limit), maxChars);
  }

  const selectedEntries = candidates.filter((entry) => selectedIds.has(entry.stateId)).slice(0, limit);
  if (selectedEntries.length === 0) {
    return formatAgentMemorySnippet(candidates.slice(0, limit), maxChars);
  }

  return formatAgentMemorySnippet(selectedEntries, maxChars);
}
