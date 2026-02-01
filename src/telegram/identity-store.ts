import { getKvClient, type KvKey, type LoggerLike } from "../github/utils/kv-client.ts";

export type TelegramLinkedIdentity = Readonly<{
  owner: string;
  linkedAt?: string;
}>;

export type TelegramIdentityLookupResult = { ok: true; identity: TelegramLinkedIdentity | null } | { ok: false; error: string };

export type TelegramLinkCodeResult = { ok: true; code: string; expiresAtMs: number } | { ok: false; error: string };

export type TelegramLinkConsumeResult = { ok: true; userId: number } | { ok: false; error: string };

export type TelegramLinkedIdentityEntry = Readonly<{
  userId: number;
  owner: string;
  linkedAt?: string;
}>;

export type TelegramLinkedIdentityListResult =
  | { ok: true; identities: TelegramLinkedIdentityEntry[]; nextCursor: string | null }
  | { ok: false; error: string };

export type TelegramLinkIssueRecord = Readonly<{
  owner: string;
  repo: string;
  issueNumber: number;
  issueUrl: string;
  createdAtMs: number;
}>;

export type TelegramLinkIssueResult = { ok: true; issue: TelegramLinkIssueRecord | null } | { ok: false; error: string };

export type TelegramLinkCodePeekResult = { ok: true; userId: number; expiresAtMs: number } | { ok: false; error: string };

export type TelegramOwnerType = "org" | "user";

export type TelegramLinkPendingStep = "awaiting_owner" | "awaiting_close" | "awaiting_reaction";

export type TelegramLinkPendingState = Readonly<{
  code: string;
  step: TelegramLinkPendingStep;
  createdAtMs: number;
  expiresAtMs: number;
  owner?: string;
}>;

export type TelegramLinkPendingResult = { ok: true; pending: TelegramLinkPendingState | null } | { ok: false; error: string };

export type TelegramLinkIssueIndexResult = { ok: true; code: string | null } | { ok: false; error: string };

const TELEGRAM_IDENTITY_PREFIX: KvKey = ["ubiquityos", "identity", "telegram", "user"];
const TELEGRAM_LINK_CODE_PREFIX: KvKey = ["ubiquityos", "identity", "telegram", "link", "code"];
const TELEGRAM_LINK_USER_PREFIX: KvKey = ["ubiquityos", "identity", "telegram", "link", "user"];
const TELEGRAM_LINK_ISSUE_PREFIX: KvKey = ["ubiquityos", "identity", "telegram", "link", "issue"];
const TELEGRAM_LINK_ISSUE_INDEX_PREFIX: KvKey = ["ubiquityos", "identity", "telegram", "link", "issue", "by-issue"];
const TELEGRAM_LINK_PENDING_PREFIX: KvKey = ["ubiquityos", "identity", "telegram", "link", "pending"];
const TELEGRAM_OWNER_INDEX_PREFIX: KvKey = ["ubiquityos", "identity", "github", "owner"];
const TELEGRAM_LINK_CODE_TTL_MS = 10 * 60_000;
const TELEGRAM_LINK_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TELEGRAM_LINK_CODE_LENGTH = 8;
const TELEGRAM_LINKED_IDENTITY_DEFAULT_LIMIT = 50;
const TELEGRAM_LINKED_IDENTITY_MAX_LIMIT = 200;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildTelegramIdentityKey(userId: number): KvKey {
  return [...TELEGRAM_IDENTITY_PREFIX, String(userId)];
}

function parseTelegramIdentityRecord(value: unknown): TelegramLinkedIdentity | null {
  if (!isRecord(value)) return null;
  const owner = normalizeOptionalString(value.owner);
  if (!owner) return null;
  const linkedAt = normalizeOptionalString(value.linkedAt);
  return {
    owner,
    ...(linkedAt ? { linkedAt } : {}),
  };
}

function parseTelegramLinkRecord(value: unknown): { userId: number; expiresAtMs: number } | null {
  if (!isRecord(value)) return null;
  const rawUserId = value.userId;
  if (typeof rawUserId !== "number" || !Number.isFinite(rawUserId)) return null;
  const userId = Math.trunc(rawUserId);
  if (userId <= 0) return null;
  const rawExpires = value.expiresAtMs;
  if (typeof rawExpires !== "number" || !Number.isFinite(rawExpires)) return null;
  const expiresAtMs = Math.trunc(rawExpires);
  if (expiresAtMs <= 0) return null;
  return { userId, expiresAtMs };
}

function parseTelegramLinkIssueRecord(value: unknown): TelegramLinkIssueRecord | null {
  if (!isRecord(value)) return null;
  const owner = normalizeOptionalString(value.owner);
  const repo = normalizeOptionalString(value.repo);
  const issueUrl = normalizeOptionalString(value.issueUrl);
  const rawIssueNumber = value.issueNumber;
  const rawCreatedAt = value.createdAtMs;
  if (!owner || !repo || !issueUrl) return null;
  const issueNumber = typeof rawIssueNumber === "number" && Number.isFinite(rawIssueNumber) ? Math.trunc(rawIssueNumber) : null;
  if (!issueNumber || issueNumber <= 0) return null;
  const createdAtMs = typeof rawCreatedAt === "number" && Number.isFinite(rawCreatedAt) ? Math.trunc(rawCreatedAt) : null;
  if (!createdAtMs || createdAtMs <= 0) return null;
  return { owner, repo, issueNumber, issueUrl, createdAtMs };
}

function parseTelegramLinkIssueIndexRecord(value: unknown): { code: string } | null {
  if (!isRecord(value)) return null;
  const code = normalizeOptionalString(value.code);
  if (!code) return null;
  return { code };
}

function parseTelegramLinkPendingRecord(value: unknown): TelegramLinkPendingState | null {
  if (!isRecord(value)) return null;
  const code = normalizeOptionalString(value.code);
  if (!code) return null;
  const step = normalizeOptionalString(value.step) as TelegramLinkPendingStep | undefined;
  if (!step || (step !== "awaiting_owner" && step !== "awaiting_close" && step !== "awaiting_reaction")) return null;
  const rawCreated = value.createdAtMs;
  const rawExpires = value.expiresAtMs;
  if (typeof rawCreated !== "number" || !Number.isFinite(rawCreated)) return null;
  if (typeof rawExpires !== "number" || !Number.isFinite(rawExpires)) return null;
  const createdAtMs = Math.trunc(rawCreated);
  const expiresAtMs = Math.trunc(rawExpires);
  if (createdAtMs <= 0 || expiresAtMs <= 0) return null;
  const owner = normalizeOptionalString(value.owner);
  return { code, step, createdAtMs, expiresAtMs, ...(owner ? { owner } : {}) };
}

function buildTelegramLinkCodeKey(code: string): KvKey {
  return [...TELEGRAM_LINK_CODE_PREFIX, code];
}

function buildTelegramLinkUserKey(userId: number): KvKey {
  return [...TELEGRAM_LINK_USER_PREFIX, String(userId)];
}

function buildTelegramLinkIssueKey(code: string): KvKey {
  return [...TELEGRAM_LINK_ISSUE_PREFIX, code];
}

function buildTelegramLinkIssueIndexKey(owner: string, repo: string, issueNumber: number): KvKey {
  return [...TELEGRAM_LINK_ISSUE_INDEX_PREFIX, owner.toLowerCase(), repo.toLowerCase(), String(issueNumber)];
}

function buildTelegramLinkPendingKey(userId: number): KvKey {
  return [...TELEGRAM_LINK_PENDING_PREFIX, String(userId)];
}

function buildOwnerTelegramKey(owner: string, userId: number): KvKey {
  return [...TELEGRAM_OWNER_INDEX_PREFIX, owner.toLowerCase(), "telegram", String(userId)];
}

async function listOwnerTelegramUserIds(params: { kv: KvLike; owner: string; limit: number }): Promise<number[]> {
  const prefix = [...TELEGRAM_OWNER_INDEX_PREFIX, params.owner.toLowerCase(), "telegram"];
  const results: number[] = [];
  const iterator = params.kv.list({ prefix }, { limit: params.limit });
  for await (const entry of iterator) {
    const userId = parseUserIdFromOwnerKey(entry.key);
    if (userId) results.push(userId);
    if (results.length >= params.limit) break;
  }
  return results;
}

function parseUserIdFromKey(key: KvKey): number | null {
  const userPart = key[TELEGRAM_IDENTITY_PREFIX.length];
  if (typeof userPart === "number") {
    return Number.isFinite(userPart) && userPart > 0 ? Math.trunc(userPart) : null;
  }
  if (typeof userPart === "string") {
    const parsed = Number.parseInt(userPart, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function parseUserIdFromOwnerKey(key: KvKey): number | null {
  const userIndex = TELEGRAM_OWNER_INDEX_PREFIX.length + 2;
  const userPart = key[userIndex];
  if (typeof userPart === "number") {
    return Number.isFinite(userPart) && userPart > 0 ? Math.trunc(userPart) : null;
  }
  if (typeof userPart === "string") {
    const parsed = Number.parseInt(userPart, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function generateLinkCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TELEGRAM_LINK_CODE_LENGTH));
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += TELEGRAM_LINK_CODE_CHARS[bytes[i] % TELEGRAM_LINK_CODE_CHARS.length];
  }
  return out;
}

function formatLinkSnippet(code: string): string {
  return `UOS-TELEGRAM-LINK:${code}`;
}

export async function getTelegramLinkedIdentity(params: { userId: number; logger: LoggerLike }): Promise<TelegramIdentityLookupResult> {
  const kv = await getKvClient(params.logger);
  if (!kv) {
    return { ok: false, error: "KV unavailable; identity lookup is disabled." };
  }
  const key = buildTelegramIdentityKey(params.userId);
  try {
    const { value } = await kv.get(key);
    return { ok: true, identity: parseTelegramIdentityRecord(value) };
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error, key }, "Failed to load Telegram identity.");
    }
    return { ok: false, error: "Failed to load Telegram identity." };
  }
}

export async function getOrCreateTelegramLinkCode(params: { userId: number; logger: LoggerLike; now?: () => number }): Promise<TelegramLinkCodeResult> {
  const kv = await getKvClient(params.logger);
  if (!kv) {
    return { ok: false, error: "KV unavailable; cannot create link code." };
  }

  const userKey = buildTelegramLinkUserKey(params.userId);
  try {
    const existing = await kv.get(userKey);
    if (existing?.value && isRecord(existing.value)) {
      const existingCode = normalizeOptionalString(existing.value.code);
      if (existingCode) {
        const codeRecord = await kv.get(buildTelegramLinkCodeKey(existingCode));
        const parsed = parseTelegramLinkRecord(codeRecord.value);
        if (parsed) {
          return { ok: true, code: existingCode, expiresAtMs: parsed.expiresAtMs };
        }
      }
    }
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error, key: userKey }, "Failed to read existing Telegram link code.");
    }
  }

  const now = (params.now ?? Date.now)();
  let code = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateLinkCode();
    const existing = await kv.get(buildTelegramLinkCodeKey(candidate));
    if (!existing?.value) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    return { ok: false, error: "Failed to generate a unique link code." };
  }

  const expiresAtMs = now + TELEGRAM_LINK_CODE_TTL_MS;
  const codeKey = buildTelegramLinkCodeKey(code);
  const payload = { userId: params.userId, createdAtMs: now, expiresAtMs };
  await kv.set(codeKey, payload, { expireIn: TELEGRAM_LINK_CODE_TTL_MS });
  await kv.set(userKey, { code }, { expireIn: TELEGRAM_LINK_CODE_TTL_MS });
  return { ok: true, code, expiresAtMs };
}

export async function consumeTelegramLinkCode(params: { code: string; logger: LoggerLike }): Promise<TelegramLinkConsumeResult> {
  const kv = await getKvClient(params.logger);
  if (!kv) {
    return { ok: false, error: "KV unavailable; cannot verify link code." };
  }
  const codeKey = buildTelegramLinkCodeKey(params.code);
  try {
    const { value } = await kv.get(codeKey);
    const parsed = parseTelegramLinkRecord(value);
    if (!parsed) {
      return { ok: false, error: "Invalid or expired link code." };
    }
    await kv.set(codeKey, null, { expireIn: 1 });
    if (typeof kv.delete === "function") {
      await kv.delete(codeKey);
      await kv.delete(buildTelegramLinkUserKey(parsed.userId));
      await kv.delete(buildTelegramLinkIssueKey(params.code));
    }
    return { ok: true, userId: parsed.userId };
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error, key: codeKey }, "Failed to consume Telegram link code.");
    }
    return { ok: false, error: "Failed to verify link code." };
  }
}

export async function peekTelegramLinkCode(params: { code: string; logger: LoggerLike }): Promise<TelegramLinkCodePeekResult> {
  const kv = await getKvClient(params.logger);
  if (!kv) {
    return { ok: false, error: "KV unavailable; cannot read link code." };
  }
  const codeKey = buildTelegramLinkCodeKey(params.code);
  try {
    const { value } = await kv.get(codeKey);
    const parsed = parseTelegramLinkRecord(value);
    if (!parsed) {
      return { ok: false, error: "Invalid or expired link code." };
    }
    return { ok: true, userId: parsed.userId, expiresAtMs: parsed.expiresAtMs };
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error, key: codeKey }, "Failed to read Telegram link code.");
    }
    return { ok: false, error: "Failed to read link code." };
  }
}

export async function getTelegramLinkIssue(params: { code: string; logger: LoggerLike }): Promise<TelegramLinkIssueResult> {
  const kv = await getKvClient(params.logger);
  if (!kv) {
    return { ok: false, error: "KV unavailable; cannot read link issue." };
  }
  const key = buildTelegramLinkIssueKey(params.code);
  try {
    const { value } = await kv.get(key);
    return { ok: true, issue: parseTelegramLinkIssueRecord(value) };
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error, key }, "Failed to read Telegram link issue.");
    }
    return { ok: false, error: "Failed to read link issue." };
  }
}

export async function getTelegramLinkCodeForIssue(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  logger: LoggerLike;
}): Promise<TelegramLinkIssueIndexResult> {
  const kv = await getKvClient(params.logger);
  if (!kv) {
    return { ok: false, error: "KV unavailable; cannot read link issue index." };
  }
  const key = buildTelegramLinkIssueIndexKey(params.owner, params.repo, params.issueNumber);
  try {
    const { value } = await kv.get(key);
    const record = parseTelegramLinkIssueIndexRecord(value);
    return { ok: true, code: record?.code ?? null };
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error, key }, "Failed to read Telegram link issue index.");
    }
    return { ok: false, error: "Failed to read link issue index." };
  }
}

export async function getTelegramLinkPending(params: { userId: number; logger: LoggerLike }): Promise<TelegramLinkPendingResult> {
  const kv = await getKvClient(params.logger);
  if (!kv) {
    return { ok: false, error: "KV unavailable; cannot read pending link state." };
  }
  const key = buildTelegramLinkPendingKey(params.userId);
  try {
    const { value } = await kv.get(key);
    return { ok: true, pending: parseTelegramLinkPendingRecord(value) };
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error, key }, "Failed to read Telegram link pending state.");
    }
    return { ok: false, error: "Failed to read pending link state." };
  }
}

export async function saveTelegramLinkPending(params: {
  userId: number;
  code: string;
  step: TelegramLinkPendingStep;
  expiresAtMs: number;
  owner?: string;
  logger: LoggerLike;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const kv = await getKvClient(params.logger);
  if (!kv) {
    return { ok: false, error: "KV unavailable; cannot persist pending link state." };
  }
  const key = buildTelegramLinkPendingKey(params.userId);
  const ttlMs = Math.max(params.expiresAtMs - Date.now(), 1_000);
  const record: TelegramLinkPendingState = {
    code: params.code,
    step: params.step,
    createdAtMs: Date.now(),
    expiresAtMs: params.expiresAtMs,
    ...(params.owner ? { owner: params.owner } : {}),
  };
  try {
    await kv.set(key, record, { expireIn: ttlMs });
    return { ok: true };
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error, key }, "Failed to save Telegram link pending state.");
    }
    return { ok: false, error: "Failed to save pending link state." };
  }
}

export async function clearTelegramLinkPending(params: { userId: number; logger: LoggerLike }): Promise<{ ok: true } | { ok: false; error: string }> {
  const kv = await getKvClient(params.logger);
  if (!kv || typeof kv.delete !== "function") {
    return { ok: false, error: "KV unavailable; cannot clear pending link state." };
  }
  const key = buildTelegramLinkPendingKey(params.userId);
  try {
    await kv.delete(key);
    return { ok: true };
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error, key }, "Failed to clear Telegram link pending state.");
    }
    return { ok: false, error: "Failed to clear pending link state." };
  }
}

export async function saveTelegramLinkIssue(params: {
  code: string;
  issue: TelegramLinkIssueRecord;
  expiresAtMs: number;
  logger: LoggerLike;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const kv = await getKvClient(params.logger);
  if (!kv) {
    return { ok: false, error: "KV unavailable; cannot persist link issue." };
  }
  const ttlMs = Math.max(params.expiresAtMs - Date.now(), 1_000);
  const key = buildTelegramLinkIssueKey(params.code);
  const indexKey = buildTelegramLinkIssueIndexKey(params.issue.owner, params.issue.repo, params.issue.issueNumber);
  try {
    await kv.set(key, params.issue, { expireIn: ttlMs });
    await kv.set(indexKey, { code: params.code, createdAtMs: params.issue.createdAtMs }, { expireIn: ttlMs });
    return { ok: true };
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error, key }, "Failed to save Telegram link issue.");
    }
    return { ok: false, error: "Failed to save link issue." };
  }
}

export async function deleteTelegramLinkIssue(params: { code: string; logger: LoggerLike }): Promise<{ ok: true } | { ok: false; error: string }> {
  const kv = await getKvClient(params.logger);
  if (!kv || typeof kv.delete !== "function") {
    return { ok: false, error: "KV unavailable; cannot delete link issue." };
  }
  const key = buildTelegramLinkIssueKey(params.code);
  try {
    const existing = await kv.get(key);
    const record = parseTelegramLinkIssueRecord(existing.value);
    if (record) {
      const indexKey = buildTelegramLinkIssueIndexKey(record.owner, record.repo, record.issueNumber);
      await kv.delete(indexKey);
    }
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error, key }, "Failed to load Telegram link issue for cleanup.");
    }
  }

  try {
    await kv.delete(key);
    return { ok: true };
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error, key }, "Failed to delete Telegram link issue.");
    }
    return { ok: false, error: "Failed to delete link issue." };
  }
}

export async function saveTelegramLinkedIdentity(params: {
  userId: number;
  owner: string;
  ownerType: TelegramOwnerType;
  logger: LoggerLike;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const kv = await getKvClient(params.logger);
  if (!kv) {
    return { ok: false, error: "KV unavailable; cannot persist identity." };
  }
  const key = buildTelegramIdentityKey(params.userId);
  const linkedAt = new Date().toISOString();
  try {
    if (params.ownerType === "user") {
      const existingOwners = await listOwnerTelegramUserIds({ kv, owner: params.owner, limit: 2 });
      const hasOtherUser = existingOwners.some((userId) => userId !== params.userId);
      if (hasOtherUser) {
        return { ok: false, error: "This GitHub user is already linked to another Telegram account." };
      }
    }

    const existing = await kv.get(key);
    const existingRecord = parseTelegramIdentityRecord(existing.value);
    if (existingRecord && existingRecord.owner.toLowerCase() !== params.owner.toLowerCase()) {
      const oldOwnerKey = buildOwnerTelegramKey(existingRecord.owner, params.userId);
      if (typeof kv.delete === "function") {
        await kv.delete(oldOwnerKey);
      }
    }

    await kv.set(key, { owner: params.owner, linkedAt });
    await kv.set(buildOwnerTelegramKey(params.owner, params.userId), { userId: params.userId, linkedAt });
    return { ok: true };
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error, key }, "Failed to save Telegram identity.");
    }
    return { ok: false, error: "Failed to save Telegram identity." };
  }
}

export async function listTelegramLinkedIdentities(params: {
  logger: LoggerLike;
  limit?: number;
  cursor?: string | null;
}): Promise<TelegramLinkedIdentityListResult> {
  const kv = await getKvClient(params.logger);
  if (!kv) {
    return { ok: false, error: "KV unavailable; cannot list identities." };
  }
  const rawLimit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.trunc(params.limit) : undefined;
  const normalizedLimit = Math.min(Math.max(rawLimit ?? TELEGRAM_LINKED_IDENTITY_DEFAULT_LIMIT, 1), TELEGRAM_LINKED_IDENTITY_MAX_LIMIT);
  const scanLimit = Math.min(normalizedLimit * 3, TELEGRAM_LINKED_IDENTITY_MAX_LIMIT * 2);
  const identities: TelegramLinkedIdentityEntry[] = [];

  try {
    const options: { limit: number; cursor?: string } = { limit: scanLimit };
    const cursor = params.cursor?.trim();
    if (cursor) options.cursor = cursor;
    const iterator = kv.list({ prefix: TELEGRAM_IDENTITY_PREFIX }, options);
    for await (const entry of iterator) {
      const record = parseTelegramIdentityRecord(entry.value);
      if (!record) continue;
      const userId = parseUserIdFromKey(entry.key);
      if (!userId) continue;
      identities.push({ userId, owner: record.owner, linkedAt: record.linkedAt });
      if (identities.length >= normalizedLimit) break;
    }
    const nextCursor = iterator.cursor && iterator.cursor.length > 0 ? iterator.cursor : null;
    return { ok: true, identities, nextCursor };
  } catch (error) {
    if (typeof params.logger.warn === "function") {
      params.logger.warn({ err: error }, "Failed to list Telegram identities.");
    }
    return { ok: false, error: "Failed to list Telegram identities." };
  }
}

export { formatLinkSnippet as formatTelegramLinkSnippet };
