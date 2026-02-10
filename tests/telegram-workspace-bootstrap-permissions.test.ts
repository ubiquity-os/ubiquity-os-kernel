import { assertEquals } from "jsr:@std/assert";

import process from "node:process";
import { app } from "../src/kernel.ts";
import { loadTelegramWorkspaceBootstrapByChat, saveTelegramWorkspaceBootstrap } from "../src/telegram/workspace-bootstrap-store.ts";
import { stubFetch } from "./test-utils/fetch-stub.ts";

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

Deno.test("telegram workspace bootstrap: promotes owner with full admin permissions", async () => {
  const originalEnv = { ...process.env };
  const originalTelegramEnv = Deno.env.get("UOS_TELEGRAM");
  const denoAny = globalThis as unknown as { Deno?: Record<string, unknown> };
  const deno = (denoAny.Deno ?? {}) as Record<string, unknown> & {
    openKv?: () => Promise<unknown>;
  };
  const originalOpenKv = deno.openKv;

  const kv = new InMemoryKv();
  deno.openKv = async () => kv as unknown;

  const botToken = "123:abc";
  const botId = "123";
  const chatId = -100_123;
  const userId = 42;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const nowEpochSeconds = Math.trunc(nowMs / 1000);

  let getChatMemberCalls = 0;
  let promoteCalls = 0;
  const state = {
    promoteBody: null as Record<string, unknown> | null,
  };

  const fetchStub = stubFetch({
    [`https://api.telegram.org/bot${botToken}/getChatMember`]: async (request) => {
      getChatMemberCalls++;
      const status = getChatMemberCalls === 1 ? "member" : "administrator";
      const payload = await request.json().catch(() => null);
      assertEquals((payload as { chat_id?: unknown } | null)?.chat_id, chatId);
      assertEquals((payload as { user_id?: unknown } | null)?.user_id, userId);
      return new Response(JSON.stringify({ ok: true, result: { status } }), {
        headers: { "content-type": "application/json" },
      });
    },
    [`https://api.telegram.org/bot${botToken}/promoteChatMember`]: async (request) => {
      promoteCalls++;
      state.promoteBody = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  try {
    process.env = {
      ...originalEnv,
      UOS_TELEGRAM: JSON.stringify({ botToken }),
    } as never;
    Deno.env.set("UOS_TELEGRAM", JSON.stringify({ botToken }));

    const saveResult = await saveTelegramWorkspaceBootstrap({
      kv: kv as never,
      botId,
      userId,
      chatId,
      inviteLink: "https://t.me/+test",
      ttlMs: 60_000,
      logger,
      now: () => ({ nowIso, nowMs }),
    });
    assertEquals(saveResult.ok, true);

    const update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: nowEpochSeconds,
        chat: {
          id: chatId,
          type: "supergroup",
          is_forum: true,
          title: "Workspace",
        },
        new_chat_members: [{ id: userId, is_bot: false, first_name: "Alex" }],
      },
    };

    const res = await app.request("http://localhost:8080/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });

    assertEquals(res.status, 200);

    assertEquals(getChatMemberCalls, 2);
    assertEquals(promoteCalls, 1);
    const body = (state.promoteBody ?? {}) as Record<string, unknown>;

    assertEquals(body["chat_id"], chatId);
    assertEquals(body["user_id"], userId);

    // Full admin permissions for workspace owner.
    assertEquals(body["can_manage_topics"], true);
    assertEquals(body["can_invite_users"], true);
    assertEquals(body["can_pin_messages"], true);
    assertEquals(body["can_change_info"], true);
    assertEquals(body["can_delete_messages"], true);
    assertEquals(body["can_restrict_members"], true);
    assertEquals(body["can_promote_members"], true);
    assertEquals(body["can_manage_chat"], true);
    assertEquals(body["can_manage_video_chats"], true);
    assertEquals(body["is_anonymous"], false);

    const pendingAfter = await loadTelegramWorkspaceBootstrapByChat({
      kv: kv as never,
      botId,
      chatId,
      logger,
      nowMs,
    });
    assertEquals(pendingAfter, null);
  } finally {
    process.env = originalEnv;
    if (originalTelegramEnv === undefined) {
      Deno.env.delete("UOS_TELEGRAM");
    } else {
      Deno.env.set("UOS_TELEGRAM", originalTelegramEnv);
    }
    deno.openKv = originalOpenKv;
    fetchStub.restore();
  }
});

Deno.test("telegram workspace bootstrap: promotes owner via chat_member updates", async () => {
  const originalEnv = { ...process.env };
  const originalTelegramEnv = Deno.env.get("UOS_TELEGRAM");
  const denoAny = globalThis as unknown as { Deno?: Record<string, unknown> };
  const deno = (denoAny.Deno ?? {}) as Record<string, unknown> & {
    openKv?: () => Promise<unknown>;
  };
  const originalOpenKv = deno.openKv;

  const kv = new InMemoryKv();
  deno.openKv = async () => kv as unknown;

  const botToken = "123:abc";
  const botId = "123";
  const chatId = -100_123;
  const userId = 42;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const nowEpochSeconds = Math.trunc(nowMs / 1000);

  let getChatMemberCalls = 0;
  let promoteCalls = 0;
  const state = {
    promoteBody: null as Record<string, unknown> | null,
  };

  const fetchStub = stubFetch({
    [`https://api.telegram.org/bot${botToken}/getChatMember`]: async (request) => {
      getChatMemberCalls++;
      const status = getChatMemberCalls === 1 ? "member" : "administrator";
      const payload = await request.json().catch(() => null);
      assertEquals((payload as { chat_id?: unknown } | null)?.chat_id, chatId);
      assertEquals((payload as { user_id?: unknown } | null)?.user_id, userId);
      return new Response(JSON.stringify({ ok: true, result: { status } }), {
        headers: { "content-type": "application/json" },
      });
    },
    [`https://api.telegram.org/bot${botToken}/promoteChatMember`]: async (request) => {
      promoteCalls++;
      state.promoteBody = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  try {
    process.env = {
      ...originalEnv,
      UOS_TELEGRAM: JSON.stringify({ botToken }),
    } as never;
    Deno.env.set("UOS_TELEGRAM", JSON.stringify({ botToken }));

    const saveResult = await saveTelegramWorkspaceBootstrap({
      kv: kv as never,
      botId,
      userId,
      chatId,
      inviteLink: "https://t.me/+test",
      ttlMs: 60_000,
      logger,
      now: () => ({ nowIso, nowMs }),
    });
    assertEquals(saveResult.ok, true);

    const update = {
      update_id: 1,
      chat_member: {
        date: nowEpochSeconds,
        chat: {
          id: chatId,
          type: "supergroup",
          is_forum: true,
          title: "Workspace",
        },
        old_chat_member: {
          user: { id: userId, first_name: "Alex" },
          status: "left",
        },
        new_chat_member: {
          user: { id: userId, first_name: "Alex" },
          status: "member",
        },
      },
    };

    const res = await app.request("http://localhost:8080/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });

    assertEquals(res.status, 200);

    assertEquals(getChatMemberCalls, 2);
    assertEquals(promoteCalls, 1);
    const body = (state.promoteBody ?? {}) as Record<string, unknown>;

    assertEquals(body["chat_id"], chatId);
    assertEquals(body["user_id"], userId);

    // Full admin permissions for workspace owner.
    assertEquals(body["can_manage_topics"], true);
    assertEquals(body["can_invite_users"], true);
    assertEquals(body["can_pin_messages"], true);
    assertEquals(body["can_change_info"], true);
    assertEquals(body["can_delete_messages"], true);
    assertEquals(body["can_restrict_members"], true);
    assertEquals(body["can_promote_members"], true);
    assertEquals(body["can_manage_chat"], true);
    assertEquals(body["can_manage_video_chats"], true);
    assertEquals(body["is_anonymous"], false);

    const pendingAfter = await loadTelegramWorkspaceBootstrapByChat({
      kv: kv as never,
      botId,
      chatId,
      logger,
      nowMs,
    });
    assertEquals(pendingAfter, null);
  } finally {
    process.env = originalEnv;
    if (originalTelegramEnv === undefined) {
      Deno.env.delete("UOS_TELEGRAM");
    } else {
      Deno.env.set("UOS_TELEGRAM", originalTelegramEnv);
    }
    deno.openKv = originalOpenKv;
    fetchStub.restore();
  }
});
