import { assert, assertEquals } from "jsr:@std/assert";

import { claimTelegramWorkspace, loadTelegramWorkspaceByChat, loadTelegramWorkspaceByUser, unclaimTelegramWorkspace } from "../src/telegram/workspace-store.ts";

type KvEntry = { key: unknown[]; value: unknown };

class InMemoryKv {
  private _entries: KvEntry[] = [];

  async get(key: readonly unknown[]) {
    const found = this._entries.find((entry) => JSON.stringify(entry.key) === JSON.stringify(key));
    return { value: found?.value ?? null, versionstamp: null };
  }

  async set(key: readonly unknown[], value: unknown) {
    this._entries = this._entries.filter((entry) => JSON.stringify(entry.key) !== JSON.stringify(key));
    this._entries.push({ key: [...key], value });
    return null;
  }

  async delete(key: readonly unknown[]) {
    this._entries = this._entries.filter((entry) => JSON.stringify(entry.key) !== JSON.stringify(key));
    return null;
  }

  list(selector: { prefix: readonly unknown[] }, options: { reverse?: boolean; limit?: number; cursor?: string } = {}) {
    void selector;
    void options;
    return {
      cursor: "",
      async *[Symbol.asyncIterator]() {
        // unused
      },
    };
  }
}

const logger = { warn: () => {} };

Deno.test("telegram workspace store: claims and unclaims a workspace group", async () => {
  const kv = new InMemoryKv();
  const botId = "123";

  const first = await claimTelegramWorkspace({ kv, botId, userId: 10, chatId: -1001, logger, now: () => "2026-01-01T00:00:00.000Z" });
  assert(first.ok);
  if (!first.ok) return;
  assertEquals(first.changed, true);

  const byUser = await loadTelegramWorkspaceByUser({ kv, botId, userId: 10, logger });
  assert(byUser);
  assertEquals(byUser.chatId, -1001);

  const byChat = await loadTelegramWorkspaceByChat({ kv, botId, chatId: -1001, logger });
  assert(byChat);
  assertEquals(byChat.userId, 10);

  const second = await claimTelegramWorkspace({ kv, botId, userId: 10, chatId: -1001, logger, now: () => "2026-01-02T00:00:00.000Z" });
  assert(second.ok);
  if (!second.ok) return;
  assertEquals(second.changed, false);

  const unclaim = await unclaimTelegramWorkspace({ kv, botId, userId: 10, logger });
  assert(unclaim.ok);
  if (!unclaim.ok) return;
  assertEquals(unclaim.removed, true);

  const afterUser = await loadTelegramWorkspaceByUser({ kv, botId, userId: 10, logger });
  assertEquals(afterUser, null);
});

Deno.test("telegram workspace store: prevents claiming an already-claimed group", async () => {
  const kv = new InMemoryKv();
  const botId = "123";

  const first = await claimTelegramWorkspace({ kv, botId, userId: 1, chatId: -200, logger });
  assert(first.ok);

  const second = await claimTelegramWorkspace({ kv, botId, userId: 2, chatId: -200, logger });
  assertEquals(second.ok, false);
});

Deno.test("telegram workspace store: prevents a user from claiming multiple groups", async () => {
  const kv = new InMemoryKv();
  const botId = "123";

  const first = await claimTelegramWorkspace({ kv, botId, userId: 1, chatId: -200, logger });
  assert(first.ok);

  const second = await claimTelegramWorkspace({ kv, botId, userId: 1, chatId: -201, logger });
  assertEquals(second.ok, false);
});
