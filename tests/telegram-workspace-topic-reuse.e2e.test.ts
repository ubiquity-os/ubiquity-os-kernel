import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { stub } from "jsr:@std/testing/mock";

import process from "node:process";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";

import { app } from "../src/kernel.ts";
import { saveTelegramLinkedIdentity } from "../src/telegram/identity-store.ts";
import { claimTelegramWorkspace } from "../src/telegram/workspace-store.ts";

type KvEntry = { key: unknown[]; value: unknown };

const TELEGRAM_WEBHOOK_URL = "http://localhost:8080/telegram";

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

function encodeBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

Deno.test({
  name: "telegram workspace: reuses existing repo topic even if stored context is issue-scoped",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const originalEnv = { ...process.env };
    const originalDenoEnv = new Map<string, string | undefined>();
    for (const key of ["ENVIRONMENT", "UOS_TELEGRAM", "UOS_GITHUB", "UOS_AI", "UOS_AGENT", "UOS_KERNEL"]) {
      originalDenoEnv.set(key, Deno.env.get(key));
    }

    const denoAny = globalThis as unknown as { Deno?: Record<string, unknown> };
    const deno = (denoAny.Deno ?? {}) as Record<string, unknown> & {
      openKv?: () => Promise<unknown>;
    };
    const originalOpenKv = deno.openKv;

    const kv = new InMemoryKv();
    deno.openKv = async () => kv as unknown;

    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const botToken = "123:abc";
    const botId = "123";
    const chatId = -1001234567890;
    const userId = 42;
    const linkedOwner = "workspace-owner";
    const orgConfigInstallationId = 888;
    const routedRepoInstallationId = 889;
    const aiBaseUrl = "https://ai.test";
    const configYaml = ["plugins: {}", "channels:", "  telegram:", "    mode: shim", `    owner: ${linkedOwner}`, ""].join("\n");

    const telegramSendBodies: Record<string, unknown>[] = [];
    const telegramTopicBodies: Record<string, unknown>[] = [];
    let nextTelegramMessageId = 200;

    const fetchStub = stub(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
      const url = new URL(request.url);

      if (url.hostname === "api.telegram.org") {
        if (!url.pathname.startsWith(`/bot${botToken}/`)) {
          return new Response(JSON.stringify({ ok: false, description: "wrong bot" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        const method = url.pathname.slice(`/bot${botToken}/`.length);
        const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (method === "sendMessage") {
          nextTelegramMessageId += 1;
          telegramSendBodies.push({
            ...(payload ?? {}),
            __sent_message_id: nextTelegramMessageId,
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: { message_id: nextTelegramMessageId },
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        if (method === "createForumTopic") {
          telegramTopicBodies.push(payload ?? {});
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                message_thread_id: 271,
                name: String(payload?.["name"] ?? ""),
              },
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        if (method === "sendChatAction" || method === "setMyCommands" || method === "pinChatMessage" || method === "answerCallbackQuery") {
          return new Response(JSON.stringify({ ok: true, result: true }), {
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unhandled Telegram API method: ${method}`);
      }

      if (url.origin === aiBaseUrl && url.pathname === "/v1/chat/completions") {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "reply",
                    reply: "Acknowledged in topic.",
                  }),
                },
              },
            ],
          }),
          {
            headers: { "content-type": "application/json" },
          }
        );
      }

      if (url.origin === "https://api.github.com") {
        const method = request.method.toUpperCase();
        let decodedPath = url.pathname;
        try {
          decodedPath = decodeURIComponent(url.pathname);
        } catch {
          decodedPath = url.pathname;
        }

        if (method === "GET" && decodedPath === `/repos/${linkedOwner}/.ubiquity-os/installation`) {
          return new Response(JSON.stringify({ id: orgConfigInstallationId }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "GET" && decodedPath === `/orgs/${linkedOwner}/installation`) {
          return new Response(JSON.stringify({ id: orgConfigInstallationId }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "GET" && decodedPath === "/repos/acme/widgets/installation") {
          return new Response(JSON.stringify({ id: routedRepoInstallationId }), {
            headers: { "content-type": "application/json" },
          });
        }

        const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
        if (method === "POST" && tokenMatch) {
          const installationId = Number(tokenMatch[1]);
          return new Response(
            JSON.stringify({
              token: `ghs_${installationId}`,
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            }),
            { headers: { "content-type": "application/json" } }
          );
        }

        if (method === "GET" && decodedPath.startsWith(`/repos/${linkedOwner}/.ubiquity-os/contents/.github/.ubiquity-os.config`)) {
          return new Response(
            JSON.stringify({
              content: encodeBase64(configYaml),
              encoding: "base64",
              sha: "config-org-sha",
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        if (method === "GET" && decodedPath.startsWith("/repos/acme/widgets/contents/.github/.ubiquity-os.config")) {
          return new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "GET" && decodedPath.startsWith("/repos/acme/.ubiquity-os/contents/.github/.ubiquity-os.config")) {
          return new Response(
            JSON.stringify({
              content: encodeBase64("plugins: {}\n"),
              encoding: "base64",
              sha: "acme-org-config-sha",
            }),
            {
              headers: { "content-type": "application/json" },
            }
          );
        }

        throw new Error(`Unhandled GitHub API: ${method} ${decodedPath}`);
      }

      throw new Error(`Unexpected fetch: ${request.method} ${request.url}`);
    });

    try {
      process.env = {
        ...originalEnv,
        ENVIRONMENT: "production",
        UOS_TELEGRAM: JSON.stringify({ botToken }),
        UOS_GITHUB: JSON.stringify({
          appId: "1",
          webhookSecret: "test-webhook",
          privateKey: privateKeyPem,
        }),
        UOS_AI: JSON.stringify({
          baseUrl: aiBaseUrl,
          token: "ai-token",
        }),
        UOS_AGENT: JSON.stringify({
          owner: "agent-owner",
          repo: "agent-repo",
          workflow: "agent.yml",
          ref: "main",
        }),
        UOS_KERNEL: JSON.stringify({}),
      } as never;

      Deno.env.set("ENVIRONMENT", "production");
      Deno.env.set("UOS_TELEGRAM", JSON.stringify({ botToken }));
      Deno.env.set(
        "UOS_GITHUB",
        JSON.stringify({
          appId: "1",
          webhookSecret: "test-webhook",
          privateKey: privateKeyPem,
        })
      );
      Deno.env.set("UOS_AI", JSON.stringify({ baseUrl: aiBaseUrl, token: "ai-token" }));
      Deno.env.set(
        "UOS_AGENT",
        JSON.stringify({
          owner: "agent-owner",
          repo: "agent-repo",
          workflow: "agent.yml",
          ref: "main",
        })
      );
      Deno.env.set("UOS_KERNEL", JSON.stringify({}));

      const logger = { warn: () => {} };
      const identitySave = await saveTelegramLinkedIdentity({
        userId,
        owner: linkedOwner,
        ownerType: "org",
        logger,
      });
      assertEquals(identitySave.ok, true);

      const claimed = await claimTelegramWorkspace({
        kv,
        botId,
        userId,
        chatId,
        logger,
      });
      assertEquals(claimed.ok, true);

      const firstUpdate = {
        update_id: 1,
        message: {
          message_id: 501,
          date: Math.trunc(Date.now() / 1000),
          chat: {
            id: chatId,
            type: "supergroup",
            is_forum: true,
            title: "UbiquityOS Workspace",
          },
          from: { id: userId, is_bot: false, first_name: "Alex" },
          text: "Please work in this repo: https://github.com/acme/widgets",
        },
      };

      const firstRes = await app.request(TELEGRAM_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(firstUpdate),
      });
      assertEquals(firstRes.status, 200);

      assertEquals(telegramTopicBodies.length, 1);
      assertStringIncludes(String(telegramTopicBodies[0]["name"] ?? ""), "acme/widgets");

      // Simulate session issue creation overwriting topic context (e.g. agent run approval).
      const topicContextKey = ["ubiquityos", "telegram", "context", botId, String(chatId), "topic", "271"];
      await kv.set(topicContextKey, {
        kind: "issue",
        owner: "acme",
        repo: "widgets",
        issueNumber: 999,
        updatedAt: new Date().toISOString(),
      });

      const secondUpdate = {
        update_id: 2,
        message: {
          message_id: 502,
          date: Math.trunc(Date.now() / 1000),
          chat: {
            id: chatId,
            type: "supergroup",
            is_forum: true,
            title: "UbiquityOS Workspace",
          },
          from: { id: userId, is_bot: false, first_name: "Alex" },
          text: "Run another task in https://github.com/acme/widgets",
        },
      };

      const secondRes = await app.request(TELEGRAM_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(secondUpdate),
      });
      assertEquals(secondRes.status, 200);

      // Regression: should not create a duplicate topic for the same repo.
      assertEquals(telegramTopicBodies.length, 1);

      const routedTopicMessages = telegramSendBodies.filter(
        (body) => body["message_thread_id"] === 271 && typeof body["text"] === "string" && String(body["text"]).includes("Context auto-scoped to acme/widgets")
      );
      assert(routedTopicMessages.length >= 2);

      const persisted = await kv.get(topicContextKey);
      const storedOverride = persisted.value as {
        kind?: unknown;
        owner?: unknown;
        repo?: unknown;
        issueNumber?: unknown;
      } | null;
      assert(storedOverride);
      assertEquals(storedOverride.kind, "repo");
      assertEquals(storedOverride.owner, "acme");
      assertEquals(storedOverride.repo, "widgets");
      assertEquals(storedOverride.issueNumber, undefined);
    } finally {
      process.env = originalEnv;
      for (const [key, value] of originalDenoEnv.entries()) {
        if (value === undefined) {
          Deno.env.delete(key);
        } else {
          Deno.env.set(key, value);
        }
      }
      deno.openKv = originalOpenKv;
      fetchStub.restore();
    }
  },
});
