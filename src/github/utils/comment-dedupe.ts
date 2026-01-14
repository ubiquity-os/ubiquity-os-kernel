import { logger } from "../../logger/logger.ts";
import { getKvClient, type KvKey } from "./kv-client.ts";

const inMemoryExpiryMsByKey = new Map<string, number>();
const MAX_IN_MEMORY_ENTRIES = 2000;

function buildInMemoryKey(owner: string, repo: string, eventName: string, commentId: number): string {
  return `${owner}/${repo}/${eventName}/${commentId}`;
}

function buildKvKey(owner: string, repo: string, eventName: string, commentId: number): KvKey {
  return ["ubiquityos", "dedupe", "comment", owner, repo, eventName, commentId];
}

function hasUnexpiredLocalMark(key: string, nowMs: number): boolean {
  const expiresAt = inMemoryExpiryMsByKey.get(key);
  if (!expiresAt) return false;
  if (expiresAt > nowMs) return true;
  inMemoryExpiryMsByKey.delete(key);
  return false;
}

function markLocal(key: string, expiresAtMs: number) {
  inMemoryExpiryMsByKey.set(key, expiresAtMs);
  while (inMemoryExpiryMsByKey.size > MAX_IN_MEMORY_ENTRIES) {
    const oldestKey = inMemoryExpiryMsByKey.keys().next().value;
    if (!oldestKey) break;
    inMemoryExpiryMsByKey.delete(oldestKey);
  }
}

export async function shouldSkipDuplicateCommentEvent(
  params: Readonly<{
    owner: string;
    repo: string;
    eventName: string;
    commentId: number;
    ttlSeconds?: number;
  }>
): Promise<boolean> {
  const owner = params.owner.trim();
  const repo = params.repo.trim();
  const eventName = params.eventName.trim();
  const commentId = params.commentId;
  const ttlSeconds = typeof params.ttlSeconds === "number" && Number.isFinite(params.ttlSeconds) ? Math.max(10, params.ttlSeconds) : 10 * 60;

  if (!owner || !repo || !eventName) return false;
  if (!Number.isFinite(commentId) || commentId <= 0) return false;

  const nowMs = Date.now();
  const ttlMs = ttlSeconds * 1000;
  const keyString = buildInMemoryKey(owner, repo, eventName, commentId);

  if (hasUnexpiredLocalMark(keyString, nowMs)) return true;

  const kv = await getKvClient();
  if (kv) {
    const key = buildKvKey(owner, repo, eventName, commentId);
    const existing = await kv.get(key);
    const hasSeen = existing.value !== null && existing.value !== undefined;
    if (hasSeen) {
      markLocal(keyString, nowMs + ttlMs);
      return true;
    }
    try {
      await kv.set(key, { seenAt: new Date(nowMs).toISOString() }, { expireIn: ttlMs });
    } catch (error) {
      logger.warn({ err: error, owner, repo, eventName, commentId }, "Failed to persist comment dedupe marker");
    }
  }

  markLocal(keyString, nowMs + ttlMs);
  return false;
}
