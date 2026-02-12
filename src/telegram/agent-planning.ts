import type { KvKey, KvLike, LoggerLike } from "../github/utils/kv-client.ts";

export type TelegramAgentPlanningStatus = "collecting" | "awaiting_approval";

export type TelegramAgentPlanningDraft = Readonly<{
  title: string;
  questions: string[];
  plan: string[];
  agentTask: string;
}>;

export type TelegramAgentPlanningSession = Readonly<{
  version: 1;
  id: string;
  status: TelegramAgentPlanningStatus;
  request: string;
  answers: string[];
  draft: TelegramAgentPlanningDraft | null;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
}>;

const TELEGRAM_AGENT_PLANNING_PREFIX: KvKey = ["ubiquityos", "telegram", "agent-planning"];

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildTelegramAgentPlanningKey(params: { botId: string; chatId: number; threadId?: number | null; userId: number }): KvKey {
  const threadId = typeof params.threadId === "number" && Number.isFinite(params.threadId) && params.threadId > 0 ? Math.trunc(params.threadId) : null;
  return [...TELEGRAM_AGENT_PLANNING_PREFIX, params.botId, String(params.chatId), ...(threadId ? ["topic", String(threadId)] : ["dm"]), String(params.userId)];
}

function parseDraft(value: unknown): TelegramAgentPlanningDraft | null {
  if (!isRecord(value)) return null;
  const title = normalizeOptionalString(value.title) ?? "";
  const questions = Array.isArray(value.questions)
    ? value.questions.map((item) => normalizeOptionalString(item)).filter((item): item is string => Boolean(item))
    : [];
  const plan = Array.isArray(value.plan) ? value.plan.map((item) => normalizeOptionalString(item)).filter((item): item is string => Boolean(item)) : [];
  const agentTask = normalizeOptionalString(value.agentTask) ?? "";
  return { title, questions, plan, agentTask };
}

export function parseTelegramAgentPlanningSession(value: unknown): TelegramAgentPlanningSession | null {
  if (!isRecord(value)) return null;

  const versionRaw = value.version;
  if (versionRaw !== 1) return null;

  const id = normalizeOptionalString(value.id);
  const statusRaw = normalizeOptionalString(value.status);
  let status: TelegramAgentPlanningStatus | null = null;
  if (statusRaw === "collecting") {
    status = "collecting";
  } else if (statusRaw === "awaiting_approval") {
    status = "awaiting_approval";
  }
  const request = normalizeOptionalString(value.request);
  const createdAtMsRaw = value.createdAtMs;
  const updatedAtMsRaw = value.updatedAtMs;
  const expiresAtMsRaw = value.expiresAtMs;
  const createdAtMs = typeof createdAtMsRaw === "number" && Number.isFinite(createdAtMsRaw) ? Math.trunc(createdAtMsRaw) : null;
  const updatedAtMs = typeof updatedAtMsRaw === "number" && Number.isFinite(updatedAtMsRaw) ? Math.trunc(updatedAtMsRaw) : null;
  const expiresAtMs = typeof expiresAtMsRaw === "number" && Number.isFinite(expiresAtMsRaw) ? Math.trunc(expiresAtMsRaw) : null;

  if (!id || !status || !request || !createdAtMs || !updatedAtMs || !expiresAtMs) {
    return null;
  }

  const answers = Array.isArray(value.answers)
    ? value.answers.map((item) => normalizeOptionalString(item)).filter((item): item is string => Boolean(item))
    : [];

  const draft = value.draft ? parseDraft(value.draft) : null;

  return {
    version: 1,
    id,
    status,
    request,
    answers,
    draft,
    createdAtMs,
    updatedAtMs,
    expiresAtMs,
  };
}

export async function loadTelegramAgentPlanningSession(params: {
  kv: KvLike;
  key: KvKey;
  nowMs?: number;
  logger?: LoggerLike;
}): Promise<TelegramAgentPlanningSession | null> {
  try {
    const { value } = await params.kv.get(params.key);
    const session = parseTelegramAgentPlanningSession(value);
    if (!session) return null;

    const nowMs = typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? Math.trunc(params.nowMs) : Date.now();
    if (session.expiresAtMs <= nowMs) {
      if (typeof params.kv.delete === "function") {
        try {
          await params.kv.delete(params.key);
        } catch (error) {
          params.logger?.warn?.({ err: error }, "Failed to delete expired Telegram agent plan session");
        }
      }
      return null;
    }

    return session;
  } catch (error) {
    params.logger?.warn?.({ err: error }, "Failed to load Telegram agent plan session");
    return null;
  }
}

export async function saveTelegramAgentPlanningSession(params: {
  kv: KvLike;
  key: KvKey;
  session: TelegramAgentPlanningSession;
  logger?: LoggerLike;
  nowMs?: number;
}): Promise<boolean> {
  const nowMs = typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? Math.trunc(params.nowMs) : Date.now();
  const ttlMs = Math.max(1, params.session.expiresAtMs - nowMs);
  const payload = {
    version: 1,
    id: params.session.id,
    status: params.session.status,
    request: params.session.request,
    answers: params.session.answers,
    draft: params.session.draft,
    createdAtMs: params.session.createdAtMs,
    updatedAtMs: params.session.updatedAtMs,
    expiresAtMs: params.session.expiresAtMs,
  };
  try {
    await params.kv.set(params.key, payload, { expireIn: ttlMs });
    return true;
  } catch (error) {
    params.logger?.warn?.({ err: error }, "Failed to persist Telegram agent plan session");
    return false;
  }
}

export async function deleteTelegramAgentPlanningSession(params: { kv: KvLike; key: KvKey; logger?: LoggerLike }): Promise<boolean> {
  if (typeof params.kv.delete !== "function") return false;
  try {
    await params.kv.delete(params.key);
    return true;
  } catch (error) {
    params.logger?.warn?.({ err: error }, "Failed to delete Telegram agent plan session");
    return false;
  }
}

export type TelegramAgentPlanningOutputStatus = "need_info" | "ready";

export type TelegramAgentPlanningOutput = Readonly<{
  status: TelegramAgentPlanningOutputStatus;
  title: string;
  questions: string[];
  plan: string[];
  agentTask?: string;
}>;

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/```$/, "")
    .trim();
}

export function tryParseTelegramAgentPlanningOutput(raw: string): TelegramAgentPlanningOutput | null {
  const cleaned = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned) as unknown;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed)) return null;

  const statusRaw = normalizeOptionalString(parsed.status);
  let status: TelegramAgentPlanningOutputStatus | null = null;
  if (statusRaw === "need_info") {
    status = "need_info";
  } else if (statusRaw === "ready") {
    status = "ready";
  }
  const title = normalizeOptionalString(parsed.title) ?? "";
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.map((item) => normalizeOptionalString(item)).filter((item): item is string => Boolean(item))
    : [];
  const plan = Array.isArray(parsed.plan) ? parsed.plan.map((item) => normalizeOptionalString(item)).filter((item): item is string => Boolean(item)) : [];
  const agentTask = normalizeOptionalString(parsed.agentTask);

  if (!status) return null;
  if (status === "ready" && !agentTask) return null;

  return {
    status,
    title,
    questions,
    plan,
    ...(agentTask ? { agentTask } : {}),
  };
}

export function buildTelegramAgentPlanningPrompt(): string {
  return [
    "You are UbiquityOS Kernel's Telegram Agent Planning module.",
    "You will be given a JSON object describing a user request from Telegram, plus optional prior answers.",
    "The input may include `repoNotes` (cached notes derived from reading the target repo). Use it to avoid asking obvious questions.",
    "The input may include `agentMemory` (recent outcomes from previous agent runs). Use it as optional context to avoid repeated questions when still relevant.",
    "Your job is to prepare an agentic run by:",
    "1) Asking only the minimum clarifying questions needed to plan correctly.",
    "2) Producing a short, concrete execution plan.",
    "3) Producing a final `agentTask` prompt for the coding agent once the request is clear.",
    "",
    "Planning behavior:",
    '- Prefer asking a complete set of clarifying questions in the FIRST "need_info" response (1-5 questions).',
    "- If `previousDraft.questions` exists, treat it as the canonical question set.",
    "  - Remove questions that have been answered.",
    "  - Do NOT introduce brand-new questions unless absolutely required to avoid a wrong plan.",
    "- If `agentMemory` already answers a question with high confidence, avoid asking that question again; carry the assumption forward in the plan.",
    "- If `repoNotes` indicates an existing runtime/stack (e.g., Deno, Node, Python), assume that stack by default and DO NOT ask what stack to use.",
    '- When enough information exists to proceed, output "ready" and make reasonable assumptions instead of asking more questions.',
    "",
    'If the input includes `forceReady: true`, you MUST stop asking questions and output status "ready" with a best-effort agentTask (make reasonable assumptions and document them in the plan/agentTask).',
    "",
    "Output requirements:",
    "- Output STRICT JSON only. No prose, no markdown.",
    "- Schema:",
    "  {",
    '    "status": "need_info" | "ready",',
    '    "title": string,',
    '    "questions": string[],',
    '    "plan": string[],',
    '    "agentTask"?: string',
    "  }",
    '- If `status` is "need_info": include 1-5 `questions` and omit `agentTask`.',
    '- If `status` is "ready": set `questions` to [] and include `agentTask`.',
    "- Keep `plan` <= 8 items and each item <= 120 chars.",
    "- Keep `agentTask` concise and focused. Avoid large dumps of text; the agent can inspect the repo as needed.",
    "",
    "Project constraints to include in the agentTask when relevant:",
    "- Do not introduce new environment variables unless explicitly approved.",
    "- Treat serverless runtime as stateless; do not rely on in-memory state for correctness.",
    "- Avoid brittle keyword/regex triggers for AI/tool selection; use explicit commands as entrypoints.",
  ].join("\n");
}
