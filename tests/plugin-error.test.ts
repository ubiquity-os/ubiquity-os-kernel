import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { assertEquals, assertExists } from "jsr:@std/assert";

import { GitHubEventHandler } from "../src/github/github-event-handler.ts";
import { bindHandlers, type HandlerDeps } from "../src/github/handlers/index.ts";
import { logger } from "../src/logger/logger.ts";
import { FakeWebhooks } from "./test-utils/fake-webhooks.ts";

const KERNEL_PLUGIN_ERROR_EVENT = "kernel.plugin_error";
const ISSUES_OPENED_EVENT = "issues.opened";
type PluginErrorPayload = {
  event?: string;
  plugin?: { type?: string; id?: string };
  trigger?: { githubEvent?: string; repo?: string };
  error?: { category?: string };
};

const TEST_APP_ID = "1";
const TEST_PRIVATE_KEY = "test-private-key";
const TEST_WEBHOOK_SECRET = "test-secret";
const TEST_MODEL = "test-model";
const MOCK_TOKEN = "mock-token";

function issuesOpenedEvent({ owner, repo }: { owner: string; repo: string }): EmitterWebhookEvent {
  return {
    id: "evt_issues_opened",
    name: "issues",
    payload: {
      action: "opened",
      installation: { id: 1 },
      sender: { type: "User", login: owner },
      issue: { number: 123 },
      repository: {
        id: 123456,
        name: repo,
        full_name: `${owner}/${repo}`,
        owner: { login: owner, id: 654321 },
      },
    },
  } as EmitterWebhookEvent;
}

async function createEventHandlerForTest() {
  const eventHandler = new GitHubEventHandler({
    environment: "production",
    webhookSecret: TEST_WEBHOOK_SECRET,
    appId: TEST_APP_ID,
    privateKey: TEST_PRIVATE_KEY,
    llm: TEST_MODEL,
    createWebhooks: (options) => new FakeWebhooks(options) as unknown as never,
  });
  eventHandler.getToken = async () => MOCK_TOKEN;
  return eventHandler;
}

Deno.test("kernel.plugin_error: dispatches to subscribed plugins when plugin dispatch fails", async () => {
  const failingPluginUrl = "https://failing-plugin.internal";
  const hotfixPluginUrl = "https://daemon-hotfix.internal";
  const owner = "test-user";
  const repo = "test-repo";

  const eventHandler = await createEventHandlerForTest();
  const triggerEvent = issuesOpenedEvent({ owner, repo });
  eventHandler.transformEvent = () =>
    ({
      id: "state_1",
      key: ISSUES_OPENED_EVENT,
      octokit: {},
      eventHandler,
      payload: triggerEvent.payload,
      logger,
    }) as never;

  const captured: Array<{ plugin: string; eventName: string; eventPayload: unknown }> = [];

  let dispatchAttempt = 0;

  const deps: Partial<HandlerDeps> = {
    getKernelCommit: async () => "deadbeef",
    getConfig: async () =>
      ({
        plugins: {
          [failingPluginUrl]: { skipBotEvents: false, with: {} },
          [hotfixPluginUrl]: { skipBotEvents: false, with: {} },
        },
      }) as never,
    getPluginsForEvent: async (context, plugins, event) => {
      void context;
      void plugins;
      if (event === ISSUES_OPENED_EVENT) {
        return [{ key: failingPluginUrl, target: failingPluginUrl, settings: { skipBotEvents: false, with: {} } }] as never;
      }
      if (event === KERNEL_PLUGIN_ERROR_EVENT) {
        return [{ key: hotfixPluginUrl, target: hotfixPluginUrl, settings: { skipBotEvents: false, with: {} } }] as never;
      }
      return [] as never;
    },
    getManifest: async (context, plugin) => {
      void context;
      const id = typeof plugin === "string" ? plugin : `${plugin.owner}/${plugin.repo}`;
      if (id === failingPluginUrl) {
        return { name: "failing-plugin", "ubiquity:listeners": [ISSUES_OPENED_EVENT], skipBotEvents: false } as never;
      }
      if (id === hotfixPluginUrl) {
        return { name: "daemon-hotfix", "ubiquity:listeners": [KERNEL_PLUGIN_ERROR_EVENT], skipBotEvents: false } as never;
      }
      return null;
    },
    resolvePluginDispatchTarget: async ({ plugin }) => ({ kind: "worker", targetUrl: String(plugin), ref: String(plugin) }) as never,
    dispatchPluginTarget: async ({ plugin, pluginInput }) => {
      const pluginId = typeof plugin === "string" ? plugin : `${plugin.owner}/${plugin.repo}`;
      captured.push({ plugin: pluginId, eventName: String(pluginInput.eventName), eventPayload: pluginInput.eventPayload });
      dispatchAttempt += 1;
      if (dispatchAttempt === 1) {
        throw new Error("HTTP 502: bad gateway");
      }
      return { target: { kind: "worker", targetUrl: pluginId, ref: pluginId } } as never;
    },
  };

  bindHandlers(eventHandler, deps);
  await (eventHandler.webhooks as unknown as FakeWebhooks<unknown>).receive(triggerEvent);

  assertEquals(captured.length, 2);
  assertEquals(captured[0].plugin, failingPluginUrl);
  assertEquals(captured[1].plugin, hotfixPluginUrl);
  assertEquals(captured[1].eventName, KERNEL_PLUGIN_ERROR_EVENT);

  const payload = captured[1].eventPayload as PluginErrorPayload;
  assertEquals(payload?.event, KERNEL_PLUGIN_ERROR_EVENT);
  assertEquals(payload?.plugin?.type, "http");
  assertEquals(payload?.plugin?.id, failingPluginUrl);
  assertEquals(payload?.trigger?.githubEvent, ISSUES_OPENED_EVENT);
  assertEquals(payload?.trigger?.repo, `${owner}/${repo}`);
});

Deno.test({
  name: "kernel.plugin_error: dispatches when handler throws",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const hotfixPluginUrl = "https://daemon-hotfix.internal";
    const owner = "test-user";
    const repo = "test-repo";

    const eventHandler = await createEventHandlerForTest();
    const triggerEvent = issuesOpenedEvent({ owner, repo });
    eventHandler.transformEvent = () =>
      ({
        id: "state_2",
        key: ISSUES_OPENED_EVENT,
        octokit: {},
        eventHandler,
        payload: triggerEvent.payload,
        logger,
      }) as never;

    const captured: Array<{ plugin: string; eventName: string; eventPayload: unknown }> = [];

    const deps: Partial<HandlerDeps> = {
      getKernelCommit: async () => "deadbeef",
      getConfig: async () =>
        ({
          plugins: {
            [hotfixPluginUrl]: { skipBotEvents: false, with: {} },
          },
        }) as never,
      getPluginsForEvent: async (context, plugins, event) => {
        void context;
        void plugins;
        if (event === ISSUES_OPENED_EVENT) {
          throw new Error("Kernel handler blew up");
        }
        if (event === KERNEL_PLUGIN_ERROR_EVENT) {
          return [{ key: hotfixPluginUrl, target: hotfixPluginUrl, settings: { skipBotEvents: false, with: {} } }] as never;
        }
        return [] as never;
      },
      getManifest: async (context, plugin) => {
        void context;
        const id = typeof plugin === "string" ? plugin : `${plugin.owner}/${plugin.repo}`;
        if (id === hotfixPluginUrl) {
          return { name: "daemon-hotfix", "ubiquity:listeners": [KERNEL_PLUGIN_ERROR_EVENT], skipBotEvents: false } as never;
        }
        return null;
      },
      resolvePluginDispatchTarget: async ({ plugin }) => ({ kind: "worker", targetUrl: String(plugin), ref: String(plugin) }) as never,
      dispatchPluginTarget: async ({ plugin, pluginInput }) => {
        const pluginId = typeof plugin === "string" ? plugin : `${plugin.owner}/${plugin.repo}`;
        captured.push({ plugin: pluginId, eventName: String(pluginInput.eventName), eventPayload: pluginInput.eventPayload });
        return { target: { kind: "worker", targetUrl: pluginId, ref: pluginId } } as never;
      },
    };

    bindHandlers(eventHandler, deps);
    await (eventHandler.webhooks as unknown as FakeWebhooks<unknown>).receive(triggerEvent);

    assertEquals(captured.length, 1);
    assertEquals(captured[0].plugin, hotfixPluginUrl);
    assertEquals(captured[0].eventName, KERNEL_PLUGIN_ERROR_EVENT);

    const payload = captured[0].eventPayload as PluginErrorPayload;
    assertExists(payload);
    assertEquals(payload?.event, KERNEL_PLUGIN_ERROR_EVENT);
    assertEquals(payload?.error?.category, "kernel");
    assertEquals(payload?.plugin?.type, "kernel");
    assertEquals(payload?.plugin?.id, "ubiquity-os/ubiquity-os-kernel");
    assertEquals(payload?.trigger?.githubEvent, ISSUES_OPENED_EVENT);
    assertEquals(payload?.trigger?.repo, `${owner}/${repo}`);
  },
});
