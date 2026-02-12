import { assertEquals } from "jsr:@std/assert";

import process from "node:process";

import { app } from "../src/kernel.ts";
import { claimTelegramWorkspace, loadTelegramWorkspaceByChat, loadTelegramWorkspaceByUser } from "../src/telegram/workspace-store.ts";
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

async function runOwnerLeaveTeardownScenario(params: { update: unknown; memberCount: number; expectedLeaveCalls: number }) {
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

  let leaveCalls = 0;
  let memberCountCalls = 0;
  let memberCountBody: Record<string, unknown> | null = null;
  let leaveBody: Record<string, unknown> | null = null;

  const fetchStub = stubFetch({
    [`https://api.telegram.org/bot${botToken}/getChatMemberCount`]: async (request) => {
      memberCountCalls += 1;
      memberCountBody = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      return new Response(JSON.stringify({ ok: true, result: params.memberCount }), {
        headers: { "content-type": "application/json" },
      });
    },
    [`https://api.telegram.org/bot${botToken}/leaveChat`]: async (request) => {
      leaveCalls += 1;
      leaveBody = (await request.json().catch(() => null)) as Record<string, unknown> | null;
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

    const claim = await claimTelegramWorkspace({
      kv: kv as never,
      botId,
      userId,
      chatId,
    });
    assertEquals(claim.ok, true);

    const res = await app.request("http://localhost:8080/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params.update),
    });

    assertEquals(res.status, 200);
    assertEquals(memberCountCalls, 1);
    assertEquals(memberCountBody?.["chat_id"], chatId);
    assertEquals(leaveCalls, params.expectedLeaveCalls);
    if (params.expectedLeaveCalls > 0) {
      assertEquals(leaveBody?.["chat_id"], chatId);
    } else {
      assertEquals(leaveBody, null);
    }

    const workspaceByUser = await loadTelegramWorkspaceByUser({
      kv: kv as never,
      botId,
      userId,
    });
    assertEquals(workspaceByUser, null);

    const workspaceByChat = await loadTelegramWorkspaceByChat({
      kv: kv as never,
      botId,
      chatId,
    });
    assertEquals(workspaceByChat, null);
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
}

Deno.test("telegram workspace: owner leave via chat_member tears down workspace and exits chat", async () => {
  await runOwnerLeaveTeardownScenario({
    memberCount: 1,
    expectedLeaveCalls: 1,
    update: {
      update_id: 1,
      chat_member: {
        date: Math.trunc(Date.now() / 1000),
        chat: {
          id: -100_123,
          type: "supergroup",
          is_forum: true,
          title: "Workspace",
        },
        old_chat_member: {
          user: { id: 42, first_name: "Alex" },
          status: "member",
        },
        new_chat_member: {
          user: { id: 42, first_name: "Alex" },
          status: "left",
        },
      },
    },
  });
});

Deno.test("telegram workspace: owner leave via left_chat_member tears down workspace and exits chat", async () => {
  await runOwnerLeaveTeardownScenario({
    memberCount: 1,
    expectedLeaveCalls: 1,
    update: {
      update_id: 2,
      message: {
        message_id: 7,
        date: Math.trunc(Date.now() / 1000),
        chat: {
          id: -100_123,
          type: "supergroup",
          is_forum: true,
          title: "Workspace",
        },
        from: {
          id: 777,
          is_bot: false,
          first_name: "Moderator",
        },
        left_chat_member: {
          id: 42,
          is_bot: false,
          first_name: "Alex",
        },
      },
    },
  });
});

Deno.test("telegram workspace: owner leave does not terminate while group still has members", async () => {
  await runOwnerLeaveTeardownScenario({
    memberCount: 2,
    expectedLeaveCalls: 0,
    update: {
      update_id: 3,
      chat_member: {
        date: Math.trunc(Date.now() / 1000),
        chat: {
          id: -100_123,
          type: "supergroup",
          is_forum: true,
          title: "Workspace",
        },
        old_chat_member: {
          user: { id: 42, first_name: "Alex" },
          status: "member",
        },
        new_chat_member: {
          user: { id: 42, first_name: "Alex" },
          status: "left",
        },
      },
    },
  });
});
