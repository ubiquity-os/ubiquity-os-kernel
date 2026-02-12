import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { stub } from "jsr:@std/testing/mock";
import process from "node:process";
import { app } from "../src/kernel.ts";
import { getTelegramLinkPending, saveTelegramLinkedIdentity, saveTelegramLinkPending } from "../src/telegram/identity-store.ts";

type KvEntry = { key: unknown[]; value: unknown };

class InMemoryKv {
  private _entries: KvEntry[] = [];

  async get(key: readonly unknown[]) {
    const found = this._entries.find((entry) => JSON.stringify(entry.key) === JSON.stringify(key));
    return { value: found?.value ?? null, versionstamp: null };
  }

  async set(key: readonly unknown[], value: unknown, options?: unknown) {
    void options;
    this._entries = this._entries.filter((entry) => JSON.stringify(entry.key) !== JSON.stringify(key));
    this._entries.push({ key: [...key], value });
    return null;
  }

  async delete(key: readonly unknown[]) {
    this._entries = this._entries.filter((entry) => JSON.stringify(entry.key) !== JSON.stringify(key));
    return null;
  }

  list(selector: { prefix: readonly unknown[] }, options: { reverse?: boolean; limit?: number; cursor?: string } = {}) {
    const prefix = [...selector.prefix];
    const isReverse = options.reverse === true;
    const limit = typeof options.limit === "number" && Number.isFinite(options.limit) ? Math.max(0, Math.trunc(options.limit)) : undefined;

    const entries = this._entries
      .filter((entry) => {
        if (prefix.length > entry.key.length) return false;
        for (let i = 0; i < prefix.length; i += 1) {
          if (JSON.stringify(prefix[i]) !== JSON.stringify(entry.key[i])) {
            return false;
          }
        }
        return true;
      })
      .map((entry) => ({ key: entry.key as unknown[], value: entry.value }));

    if (isReverse) entries.reverse();
    const limited = limit === undefined ? entries : entries.slice(0, limit);
    return {
      cursor: "",
      async *[Symbol.asyncIterator]() {
        for (const entry of limited) yield entry;
      },
    };
  }
}

const TELEGRAM_WEBHOOK_URL = "http://localhost:8080/telegram";
const TELEGRAM_API_HOSTNAME = "api.telegram.org";

type EnvKey = "ENVIRONMENT" | "UOS_TELEGRAM";

function setKernelEnv(key: EnvKey, value: string) {
  process.env[key] = value;
  Deno.env.set(key, value);
}

function restoreKernelEnv(originalProcessEnv: NodeJS.ProcessEnv, originalDenoEnv: Map<string, string | undefined>) {
  process.env = originalProcessEnv;
  for (const [key, value] of originalDenoEnv.entries()) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

Deno.test({
  name: "telegram status command: /_status handles missing githubLogin without requiring channel config",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const originalEnv = { ...process.env };
    const originalDenoEnv = new Map<string, string | undefined>();
    for (const key of ["ENVIRONMENT", "UOS_TELEGRAM"] as const) {
      originalDenoEnv.set(key, Deno.env.get(key));
    }

    const denoAny = globalThis as unknown as { Deno?: Record<string, unknown> };
    const deno = (denoAny.Deno ?? {}) as Record<string, unknown> & {
      openKv?: () => Promise<unknown>;
    };
    const originalOpenKv = deno.openKv;

    const kv = new InMemoryKv();
    deno.openKv = async () => kv as unknown;

    const botToken = "123:abc";
    const chatId = 42;
    const userId = 42;
    const telegramBodies: Record<string, unknown>[] = [];

    const fetchStub = stub(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
      const url = new URL(request.url);
      if (url.hostname !== TELEGRAM_API_HOSTNAME) {
        throw new Error(`Unexpected fetch: ${request.method} ${request.url}`);
      }
      if (!url.pathname.startsWith(`/bot${botToken}/`)) {
        throw new Error(`Unexpected bot token path: ${url.pathname}`);
      }
      const method = url.pathname.slice(`/bot${botToken}/`.length);
      const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (method === "sendMessage") {
        telegramBodies.push(payload ?? {});
        return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }), { headers: { "content-type": "application/json" } });
      }
      if (method === "sendChatAction") {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unhandled Telegram API method: ${method}`);
    });

    try {
      setKernelEnv("ENVIRONMENT", "production");
      setKernelEnv("UOS_TELEGRAM", JSON.stringify({ botToken }));

      const save = await saveTelegramLinkedIdentity({
        userId,
        owner: "0x4007",
        ownerType: "org",
        logger: { warn: () => {} },
      });
      assertEquals(save.ok, true);

      const update = {
        update_id: 1,
        message: {
          message_id: 501,
          date: Math.trunc(Date.now() / 1000),
          chat: { id: chatId, type: "private" },
          from: { id: userId, is_bot: false, first_name: "Alex" },
          text: "/_status",
        },
      };

      const res = await app.request(TELEGRAM_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      assertEquals(res.status, 200);

      const statusReply = telegramBodies.find((body) => String(body["text"] ?? "").includes("Status: linked"));
      assert(statusReply);
      assertStringIncludes(String(statusReply["text"] ?? ""), "GitHub login: missing (re-link required for agent approvals)");
      assert(!String(statusReply["text"] ?? "").includes("channels.telegram.owner"));
      const replyMarkup = statusReply["reply_markup"] as
        | {
            inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
          }
        | undefined;
      const callbackData = (replyMarkup?.inline_keyboard ?? []).flatMap((row) => row).map((btn) => String(btn.callback_data ?? ""));
      assert(callbackData.includes("link:start"));
    } finally {
      fetchStub.restore();
      deno.openKv = originalOpenKv;
      restoreKernelEnv(originalEnv, originalDenoEnv);
    }
  },
});

Deno.test({
  name: "telegram callback: link:start allows re-link when owner exists but githubLogin is missing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const originalEnv = { ...process.env };
    const originalDenoEnv = new Map<string, string | undefined>();
    for (const key of ["ENVIRONMENT", "UOS_TELEGRAM"] as const) {
      originalDenoEnv.set(key, Deno.env.get(key));
    }

    const denoAny = globalThis as unknown as { Deno?: Record<string, unknown> };
    const deno = (denoAny.Deno ?? {}) as Record<string, unknown> & {
      openKv?: () => Promise<unknown>;
    };
    const originalOpenKv = deno.openKv;

    const kv = new InMemoryKv();
    deno.openKv = async () => kv as unknown;

    const botToken = "123:abc";
    const chatId = 42;
    const userId = 42;
    const sentTexts: string[] = [];

    const fetchStub = stub(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
      const url = new URL(request.url);
      if (url.hostname !== TELEGRAM_API_HOSTNAME) {
        throw new Error(`Unexpected fetch: ${request.method} ${request.url}`);
      }
      if (!url.pathname.startsWith(`/bot${botToken}/`)) {
        throw new Error(`Unexpected bot token path: ${url.pathname}`);
      }
      const method = url.pathname.slice(`/bot${botToken}/`.length);
      const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (method === "sendMessage") {
        sentTexts.push(String(payload?.text ?? ""));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), { headers: { "content-type": "application/json" } });
      }
      if (method === "answerCallbackQuery" || method === "sendChatAction") {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unhandled Telegram API method: ${method}`);
    });

    try {
      setKernelEnv("ENVIRONMENT", "production");
      setKernelEnv("UOS_TELEGRAM", JSON.stringify({ botToken }));

      const save = await saveTelegramLinkedIdentity({
        userId,
        owner: "0x4007",
        ownerType: "org",
        logger: { warn: () => {} },
      });
      assertEquals(save.ok, true);

      const update = {
        update_id: 2,
        callback_query: {
          id: "cb-1",
          from: { id: userId, is_bot: false, first_name: "Alex" },
          data: "link:start",
          message: {
            message_id: 502,
            date: Math.trunc(Date.now() / 1000),
            chat: { id: chatId, type: "private" },
            text: "status",
          },
        },
      };

      const res = await app.request(TELEGRAM_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      assertEquals(res.status, 200);

      assert(sentTexts.some((text) => text.includes("missing GitHub login metadata. Starting re-link flow now")));
      assert(sentTexts.some((text) => text.includes("Send the GitHub owner")));
      assert(!sentTexts.some((text) => text.includes("Already linked to")));

      const pending = await getTelegramLinkPending({
        userId,
        logger: { warn: () => {} },
      });
      assertEquals(pending.ok, true);
      if (pending.ok) {
        assertEquals(pending.pending?.step, "awaiting_owner");
      }
    } finally {
      fetchStub.restore();
      deno.openKv = originalOpenKv;
      restoreKernelEnv(originalEnv, originalDenoEnv);
    }
  },
});

Deno.test({
  name: "telegram relink: pending owner step is handled before channel config when identity is linked without githubLogin",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const originalEnv = { ...process.env };
    const originalDenoEnv = new Map<string, string | undefined>();
    for (const key of ["ENVIRONMENT", "UOS_TELEGRAM"] as const) {
      originalDenoEnv.set(key, Deno.env.get(key));
    }

    const denoAny = globalThis as unknown as { Deno?: Record<string, unknown> };
    const deno = (denoAny.Deno ?? {}) as Record<string, unknown> & {
      openKv?: () => Promise<unknown>;
    };
    const originalOpenKv = deno.openKv;

    const kv = new InMemoryKv();
    deno.openKv = async () => kv as unknown;

    const botToken = "123:abc";
    const chatId = 42;
    const userId = 42;
    const sentTexts: string[] = [];

    const fetchStub = stub(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
      const url = new URL(request.url);
      if (url.hostname !== TELEGRAM_API_HOSTNAME) {
        throw new Error(`Unexpected fetch: ${request.method} ${request.url}`);
      }
      if (!url.pathname.startsWith(`/bot${botToken}/`)) {
        throw new Error(`Unexpected bot token path: ${url.pathname}`);
      }
      const method = url.pathname.slice(`/bot${botToken}/`.length);
      const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (method === "sendMessage") {
        sentTexts.push(String(payload?.text ?? ""));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 102 } }), { headers: { "content-type": "application/json" } });
      }
      if (method === "sendChatAction") {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unhandled Telegram API method: ${method}`);
    });

    try {
      setKernelEnv("ENVIRONMENT", "production");
      setKernelEnv("UOS_TELEGRAM", JSON.stringify({ botToken }));

      const save = await saveTelegramLinkedIdentity({
        userId,
        owner: "0x4007",
        ownerType: "org",
        logger: { warn: () => {} },
      });
      assertEquals(save.ok, true);

      const pending = await saveTelegramLinkPending({
        userId,
        code: "ABCDEFGH",
        step: "awaiting_owner",
        expiresAtMs: Date.now() + 10 * 60_000,
        logger: { warn: () => {} },
      });
      assertEquals(pending.ok, true);

      const update = {
        update_id: 3,
        message: {
          message_id: 503,
          date: Math.trunc(Date.now() / 1000),
          chat: { id: chatId, type: "private" },
          from: { id: userId, is_bot: false, first_name: "Alex" },
          text: "owner please",
        },
      };

      const res = await app.request(TELEGRAM_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      assertEquals(res.status, 200);

      const ownerPrompt = sentTexts.find((text) => text.includes("Send just your GitHub owner"));
      assert(ownerPrompt);
      assert(!sentTexts.some((text) => text.includes("channels.telegram.owner")));

      const pendingAfter = await getTelegramLinkPending({
        userId,
        logger: { warn: () => {} },
      });
      assertEquals(pendingAfter.ok, true);
      if (pendingAfter.ok) {
        assertEquals(pendingAfter.pending?.step, "awaiting_owner");
      }
    } finally {
      fetchStub.restore();
      deno.openKv = originalOpenKv;
      restoreKernelEnv(originalEnv, originalDenoEnv);
    }
  },
});
