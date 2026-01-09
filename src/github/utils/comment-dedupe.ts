import { getKvClient, type KvKey } from "./kv-client.ts";

const inMemoryExpiryMsByKey = new Map<string, number>();

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
    await kv.set(key, { seenAt: new Date(nowMs).toISOString() }, { expireIn: ttlMs });
  }

  markLocal(keyString, nowMs + ttlMs);
  return false;
}
