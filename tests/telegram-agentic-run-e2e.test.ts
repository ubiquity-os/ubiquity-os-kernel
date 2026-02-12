import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { stub } from "jsr:@std/testing/mock";

import process from "node:process";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";

import { app } from "../src/kernel.ts";
import { buildTelegramAgentPlanningKey } from "../src/telegram/agent-planning.ts";
import { saveTelegramLinkedIdentity } from "../src/telegram/identity-store.ts";
import { decompressString } from "@ubiquity-os/plugin-sdk/compression";

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

function makeConfigYaml(params: { owner: string; repo: string; issueNumber: number; installationId: number }): string {
  return [
    "plugins: {}",
    "channels:",
    "  telegram:",
    "    mode: github",
    `    owner: ${params.owner}`,
    `    repo: ${params.repo}`,
    `    issueNumber: ${params.issueNumber}`,
    `    installationId: ${params.installationId}`,
    "",
  ].join("\n");
}

function isAiPrompt(system: unknown, needle: string): boolean {
  return typeof system === "string" && system.includes(needle);
}

Deno.test({
  name: "telegram agentic run: planning -> approve button -> dispatch",
  // Octokit throttling uses bottleneck, which starts (unref'd) background intervals.
  // Disable sanitizers for this integration-style test.
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
    // plugin-sdk signature expects PKCS8 PEM ("BEGIN PRIVATE KEY")
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const botToken = "123:abc";
    const botId = "123";
    const chatId = 101;
    const userId = 42;
    const owner = "test-owner";
    const repo = "test-repo";
    const issueNumber = 1;
    const routingInstallationId = 999;
    const orgConfigInstallationId = 888;
    const agentOwner = "test-agent";
    const agentRepo = "agent-repo";
    const agentWorkflow = "agent.yml";
    const agentInstallationId = 777;
    const aiBaseUrl = "https://ai.test";

    const configYaml = makeConfigYaml({
      owner,
      repo,
      issueNumber,
      installationId: routingInstallationId,
    });

    const telegramSendBodies: Record<string, unknown>[] = [];
    const telegramEditMarkupBodies: Record<string, unknown>[] = [];
    const telegramChatActionBodies: Record<string, unknown>[] = [];
    const aiCalls: Array<{ system: string; user: string }> = [];

    let nextTelegramMessageId = 100;
    let dispatchedWorkflowBody: unknown = null;

    const fetchStub = stub(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
      const url = new URL(request.url);

      // Telegram API
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
        if (method === "editMessageReplyMarkup") {
          telegramEditMarkupBodies.push(payload ?? {});
          return new Response(JSON.stringify({ ok: true, result: true }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "sendChatAction") {
          telegramChatActionBodies.push(payload ?? {});
          return new Response(JSON.stringify({ ok: true, result: true }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "setMyCommands" || method === "answerCallbackQuery") {
          return new Response(JSON.stringify({ ok: true, result: true }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            ok: false,
            description: `unsupported method ${method}`,
          }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          }
        );
      }

      // AI router endpoint
      if (url.origin === aiBaseUrl && url.pathname === "/v1/chat/completions") {
        const body = (await request.json().catch(() => null)) as {
          messages?: Array<{ role?: string; content?: string }>;
        } | null;
        const system = body?.messages?.[0]?.content ?? "";
        const user = body?.messages?.[1]?.content ?? "";
        aiCalls.push({ system, user });

        if (isAiPrompt(system, "Telegram Agent Planning module")) {
          let parsedInput: { answers?: unknown } = {};
          try {
            parsedInput = JSON.parse(user) as { answers?: unknown };
          } catch {
            parsedInput = {};
          }
          const answers = Array.isArray(parsedInput.answers) ? parsedInput.answers : [];
          const assistantContent =
            answers.length === 0
              ? JSON.stringify({
                  status: "need_info",
                  title: "Telegram Agentic Run Test",
                  questions: ["What is the acceptance criteria?"],
                  plan: ["Clarify requirements", "Draft agent task"],
                })
              : JSON.stringify({
                  status: "ready",
                  title: "Telegram Agentic Run Test",
                  questions: [],
                  plan: ["Dispatch internal agent workflow", "Verify dispatch inputs"],
                  agentTask: `Implement the requested capability. Acceptance criteria: ${String(answers[0])}`,
                });
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: assistantContent } }],
            }),
            {
              headers: { "content-type": "application/json" },
            }
          );
        }

        // Router decision:
        // - When no planning session exists, start planning via "agent".
        // - When a planning session is active, treat messages as potential answers via "agent_plan".
        let routerInput: {
          agentPlanningSession?: unknown;
          comment?: unknown;
        } = {};
        try {
          routerInput = JSON.parse(user) as {
            agentPlanningSession?: unknown;
            comment?: unknown;
          };
        } catch {
          routerInput = {};
        }
        let assistantContent = "";
        if (routerInput.agentPlanningSession) {
          const comment = typeof routerInput.comment === "string" ? routerInput.comment : "";
          assistantContent = comment.includes("2+2")
            ? JSON.stringify({ action: "reply", reply: "2+2=4." })
            : JSON.stringify({ action: "agent_plan", operation: "append" });
        } else {
          assistantContent = JSON.stringify({
            action: "agent",
            task: "Plan an agentic run from Telegram",
          });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: assistantContent } }],
          }),
          {
            headers: { "content-type": "application/json" },
          }
        );
      }

      // GitHub API
      if (url.origin === "https://api.github.com") {
        const method = request.method.toUpperCase();
        const path = url.pathname;
        let decodedPath = path;
        try {
          decodedPath = decodeURIComponent(path);
        } catch {
          decodedPath = path;
        }
        const jsonBody = method === "GET" ? undefined : await request.json().catch(() => null);

        // Installation lookup
        if (method === "GET" && decodedPath === `/repos/${owner}/.ubiquity-os/installation`) {
          return new Response(JSON.stringify({ id: orgConfigInstallationId }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "GET" && decodedPath === `/repos/${agentOwner}/${agentRepo}/installation`) {
          return new Response(JSON.stringify({ id: agentInstallationId }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "GET" && decodedPath === "/orgs/ubiquity-os-marketplace/installation") {
          // Non-fatal path in internal agent dispatch; return 404 to avoid Octokit retries.
          return new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "GET" && decodedPath === "/users/ubiquity-os-marketplace/installation") {
          return new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }

        // Installation token mint
        const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
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

        // Config fetch
        if (method === "GET" && decodedPath === `/repos/${owner}/.ubiquity-os/contents/.github/.ubiquity-os.config.yml`) {
          return new Response(
            JSON.stringify({
              content: encodeBase64(configYaml),
              encoding: "base64",
              sha: "config-org-sha",
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        if (method === "GET" && decodedPath === `/repos/${owner}/${repo}/contents/.github/.ubiquity-os.config.yml`) {
          return new Response(
            JSON.stringify({
              content: encodeBase64("plugins: {}\n"),
              encoding: "base64",
              sha: "config-repo-sha",
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        if (method === "GET" && decodedPath === `/repos/${owner}/${repo}/contents`) {
          // Used by Telegram planning repo-notes cache for "obvious" stack detection.
          return new Response(
            JSON.stringify([
              { name: "deno.json", type: "file" },
              { name: "deno.lock", type: "file" },
              { name: ".github", type: "dir" },
              { name: "src", type: "dir" },
            ]),
            { headers: { "content-type": "application/json" } }
          );
        }
        if (method === "GET" && decodedPath === `/repos/${owner}/${repo}/languages`) {
          return new Response(JSON.stringify({ TypeScript: 1000 }), {
            headers: { "content-type": "application/json" },
          });
        }

        // Issue hydration (minimal; omit node_id/created_at to prevent conversation-graph fetches).
        if (method === "GET" && decodedPath === `/repos/${owner}/${repo}/issues/${issueNumber}`) {
          return new Response(
            JSON.stringify({
              number: issueNumber,
              title: "Test issue",
              body: "Test body",
              labels: [],
              user: { login: owner },
              node_id: null,
              created_at: null,
              html_url: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
              url: `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        if (method === "GET" && decodedPath === `/repos/${owner}/${repo}/collaborators/${owner}/permission`) {
          return new Response(
            JSON.stringify({
              permission: "write",
              user: { login: owner },
            }),
            { headers: { "content-type": "application/json" } }
          );
        }

        // Agent dispatch
        if (method === "GET" && decodedPath === `/repos/${agentOwner}/${agentRepo}`) {
          return new Response(JSON.stringify({ default_branch: "main" }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "POST" && decodedPath === `/repos/${agentOwner}/${agentRepo}/actions/workflows/${agentWorkflow}/dispatches`) {
          dispatchedWorkflowBody = jsonBody;
          return new Response(null, { status: 204 });
        }
        if (method === "GET" && decodedPath === `/repos/${agentOwner}/${agentRepo}/actions/workflows/${agentWorkflow}/runs`) {
          // Must match ref "main" and be recent relative to poll loop.
          return new Response(
            JSON.stringify({
              total_count: 1,
              workflow_runs: [
                {
                  html_url: `https://github.com/${agentOwner}/${agentRepo}/actions/runs/1`,
                  created_at: new Date().toISOString(),
                  event: "workflow_dispatch",
                  head_branch: "main",
                  head_sha: "deadbeef",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } }
          );
        }

        // Default: surface missing stubs clearly.
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
        UOS_AI: JSON.stringify({ baseUrl: aiBaseUrl, token: "ai-token" }),
        UOS_AGENT: JSON.stringify({
          owner: agentOwner,
          repo: agentRepo,
          workflow: agentWorkflow,
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
          owner: agentOwner,
          repo: agentRepo,
          workflow: agentWorkflow,
          ref: "main",
        })
      );
      Deno.env.set("UOS_KERNEL", JSON.stringify({}));

      const logger = { warn: () => {} };
      const identitySave = await saveTelegramLinkedIdentity({
        userId,
        owner,
        ownerType: "org",
        githubLogin: owner,
        logger,
      });
      assertEquals(identitySave.ok, true);

      // 1) Start agent planning from a DM (implicit @ubiquityos).
      const update1 = {
        update_id: 1,
        message: {
          message_id: 1,
          date: Math.trunc(Date.now() / 1000),
          chat: { id: chatId, type: "private" },
          from: { id: userId, is_bot: false, first_name: "Alex" },
          text: "Please add a planning + approval flow for feature requests.",
        },
      };

      const res1 = await app.request(TELEGRAM_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update1),
      });
      assertEquals(res1.status, 200);

      assert(telegramSendBodies.length >= 1);
      const firstMessage = telegramSendBodies.find((b) => typeof b["text"] === "string" && String(b["text"]).includes("Planning mode."));
      assert(firstMessage);
      const firstMarkup = firstMessage["reply_markup"] as
        | {
            inline_keyboard?: unknown;
          }
        | undefined;
      assert(firstMarkup?.inline_keyboard);

      const planningKey = buildTelegramAgentPlanningKey({
        botId,
        chatId,
        threadId: null,
        userId,
      });
      const storedAfterStart = await kv.get(planningKey);
      const sessionAfterStart = storedAfterStart.value as {
        id?: unknown;
        answers?: unknown;
      } | null;
      assert(sessionAfterStart);
      assertEquals(Array.isArray(sessionAfterStart.answers), true);
      assertEquals((sessionAfterStart.answers as unknown[]).length, 0);

      // 1b) Irrelevant message while plan session is active should still route via the router,
      // and MUST NOT be appended to the plan answers.
      const update1b = {
        update_id: 10,
        message: {
          message_id: 10,
          date: Math.trunc(Date.now() / 1000),
          chat: { id: chatId, type: "private" },
          from: { id: userId, is_bot: false, first_name: "Alex" },
          text: "Quick question: what's 2+2?",
        },
      };
      const res1b = await app.request(TELEGRAM_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update1b),
      });
      assertEquals(res1b.status, 200);

      const replyMessage = telegramSendBodies.find((b) => typeof b["text"] === "string" && String(b["text"]).includes("2+2=4"));
      assert(replyMessage);

      const storedAfterIrrelevant = await kv.get(planningKey);
      const sessionAfterIrrelevant = storedAfterIrrelevant.value as {
        answers?: unknown;
      } | null;
      assert(sessionAfterIrrelevant);
      assertEquals(Array.isArray(sessionAfterIrrelevant.answers), true);
      assertEquals((sessionAfterIrrelevant.answers as unknown[]).length, 0);

      // 2) Answer clarifying question -> should transition to "Plan ready." with Approve/Cancel buttons.
      const update2 = {
        update_id: 2,
        message: {
          message_id: 2,
          date: Math.trunc(Date.now() / 1000),
          chat: { id: chatId, type: "private" },
          from: { id: userId, is_bot: false, first_name: "Alex" },
          text: "Acceptance criteria: must use inline buttons for approve/cancel, and dispatch only after approval.",
        },
      };

      const res2 = await app.request(TELEGRAM_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update2),
      });
      assertEquals(res2.status, 200);

      const planReadyMessage = telegramSendBodies.find((b) => typeof b["text"] === "string" && String(b["text"]).includes("Plan ready."));
      assert(planReadyMessage);
      const planReadyMarkup = planReadyMessage["reply_markup"] as
        | {
            inline_keyboard?: Array<Array<{ text?: string; callback_data?: string; style?: string }>>;
          }
        | undefined;
      const keyboard = planReadyMarkup?.inline_keyboard ?? [];
      const callbackData = keyboard
        .flatMap((row) => row)
        .map((btn) => btn.callback_data)
        .filter(Boolean) as string[];
      assert(callbackData.some((value) => value.includes("uos_agent_plan:approve")));
      assert(callbackData.some((value) => value.includes("uos_agent_plan:cancel")));
      const cancelButton = keyboard.flatMap((row) => row).find((btn) => String(btn.callback_data ?? "").includes("uos_agent_plan:cancel"));
      assert(cancelButton);
      assertEquals(cancelButton.style, "danger");

      // Load sessionId from KV for callback query payload.
      const stored = await kv.get(planningKey);
      const sessionRecord = stored.value as { id?: unknown } | null;
      const sessionId = typeof sessionRecord?.id === "string" ? sessionRecord.id : "";
      assert(sessionId);

      // 3) Press Approve button (callback query) -> should dispatch internal agent workflow.
      const update3 = {
        update_id: 3,
        callback_query: {
          id: "cbq-1",
          from: { id: userId, is_bot: false, first_name: "Alex" },
          message: {
            message_id: 999,
            date: Math.trunc(Date.now() / 1000),
            chat: { id: chatId, type: "private" },
            text: "Plan ready.",
          },
          data: `uos_agent_plan:approve:${sessionId}`,
        },
      };
      const res3 = await app.request(TELEGRAM_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update3),
      });
      assertEquals(res3.status, 200);

      const startingMessage = telegramSendBodies.find((b) => typeof b["text"] === "string" && String(b["text"]).includes("Starting agent run."));
      assert(startingMessage);

      assert(dispatchedWorkflowBody);
      const workflowPayload = dispatchedWorkflowBody as {
        inputs?: Record<string, string>;
      } | null;
      const command = workflowPayload?.inputs?.command;
      assert(command);
      const compressedEventPayload = workflowPayload?.inputs?.eventPayload;
      assert(compressedEventPayload);
      const rawSettings = workflowPayload?.inputs?.settings;
      assert(rawSettings);
      const parsedSettings = JSON.parse(rawSettings) as {
        allowedAuthorAssociations?: unknown;
        privilegedAuthorAssociations?: unknown;
      };
      assert(Array.isArray(parsedSettings.allowedAuthorAssociations));
      assert(Array.isArray(parsedSettings.privilegedAuthorAssociations));
      assertEquals((parsedSettings.allowedAuthorAssociations as unknown[]).includes("NONE"), true);
      assertEquals((parsedSettings.privilegedAuthorAssociations as unknown[]).includes("NONE"), true);
      const parsedEventPayload = JSON.parse(decompressString(compressedEventPayload)) as {
        comment?: { user?: { login?: string }; author_association?: string };
      };
      assertEquals(parsedEventPayload.comment?.user?.login, owner);
      assertEquals(parsedEventPayload.comment?.author_association, "OWNER");
      const parsedCommand = JSON.parse(command) as {
        name?: string;
        parameters?: { task?: string };
      };
      assertEquals(parsedCommand.name, "agent");
      assert(parsedCommand.parameters?.task);
      assertStringIncludes(parsedCommand.parameters.task, "Acceptance criteria:");

      // Session should be deleted after approval.
      const after = await kv.get(planningKey);
      assertEquals(after.value, null);

      // Buttons should disappear after approval click.
      assertEquals(telegramEditMarkupBodies.length >= 1, true);
      const clearedMarkup = telegramEditMarkupBodies.find((b) => b["chat_id"] === chatId && b["message_id"] === 999);
      assert(clearedMarkup);
      const replyMarkup = clearedMarkup["reply_markup"] as
        | {
            inline_keyboard?: unknown;
          }
        | undefined;
      assert(replyMarkup);
      assertEquals(Array.isArray(replyMarkup.inline_keyboard), true);
      const inlineKeyboard = replyMarkup.inline_keyboard as unknown[];
      const isEmptyKeyboard =
        inlineKeyboard.length === 0 || (inlineKeyboard.length === 1 && Array.isArray(inlineKeyboard[0]) && (inlineKeyboard[0] as unknown[]).length === 0);
      assertEquals(isEmptyKeyboard, true);

      // Follow-up message should include Actions run URL.
      const runUrlMessage = telegramSendBodies.find(
        (b) => typeof b["text"] === "string" && String(b["text"]).includes("Run logs:") && String(b["text"]).includes(`/actions/runs/1`)
      );
      assert(runUrlMessage);

      // Typing indicator should be sent while processing (message + callback flows).
      assert(telegramChatActionBodies.some((b) => b["chat_id"] === chatId && b["action"] === "typing"));

      // Sanity: we exercised router + planning prompts at least once.
      assert(aiCalls.length >= 2);
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
