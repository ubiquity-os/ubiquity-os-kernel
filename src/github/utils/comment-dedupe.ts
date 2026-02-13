import { logger } from "../../logger/logger.ts";
import { getKvClient, type KvKey } from "./kv-client.ts";

function buildKvKey(owner: string, repo: string, eventName: string, commentId: number): KvKey {
  return ["ubiquityos", "dedupe", "comment", owner, repo, eventName, commentId];
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

  const kv = await getKvClient();
  if (!kv) {
    logger.warn({ owner, repo, eventName, commentId }, "Comment dedupe disabled; Deno KV unavailable.");
    return false;
  }
  const key = buildKvKey(owner, repo, eventName, commentId);
  try {
    const existing = await kv.get(key);
    const hasSeen = existing.value !== null && existing.value !== undefined;
    if (hasSeen) {
      return true;
    }
  } catch (error) {
    logger.error({ err: error, owner, repo, eventName, commentId }, "Failed to check comment dedupe marker");
  }
  try {
    await kv.set(key, { seenAt: new Date(nowMs).toISOString() }, { expireIn: ttlMs });
  } catch (error) {
    logger.warn({ err: error, owner, repo, eventName, commentId }, "Failed to persist comment dedupe marker");
  }
  return false;
}
