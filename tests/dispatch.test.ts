import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { assertEquals } from "jsr:@std/assert";

import { GitHubEventHandler } from "../src/github/github-event-handler.ts";
import { bindHandlers, type HandlerDeps } from "../src/github/handlers/index.ts";
import { logger } from "../src/logger/logger.ts";
import { FakeWebhooks } from "./test-utils/fake-webhooks.ts";

const TEST_APP_ID = "1";
const TEST_PRIVATE_KEY = "test-private-key";
const TEST_WEBHOOK_SECRET = "test-secret";
const TEST_MODEL = "test-model";
const MOCK_TOKEN = "mock-token";

function issueCommentCreatedEvent(commentBody: string): EmitterWebhookEvent {
  return {
    id: "evt_1",
    name: "issue_comment",
    payload: {
      action: "created",
      installation: { id: 1 },
      sender: { login: "test-user", type: "User" },
      comment: {
        id: 101,
        body: commentBody,
        user: { login: "test-user", type: "User" },
        html_url: "https://github.com/test-user/test-repo/issues/1#issuecomment-101",
      },
      issue: { number: 1, user: { login: "test-user" }, html_url: "https://github.com/test-user/test-repo/issues/1" },
      repository: {
        id: 123,
        name: "test-repo",
        full_name: "test-user/test-repo",
        owner: { login: "test-user", id: 456 },
      },
    },
  } as EmitterWebhookEvent;
}

Deno.test("handleEvent: continues dispatching plugins if one throws", async () => {
  const pluginA = "https://plugin-a.internal";
  const pluginB = "https://plugin-b.internal";

  const eventHandler = new GitHubEventHandler({
    environment: "production",
    webhookSecret: TEST_WEBHOOK_SECRET,
    appId: TEST_APP_ID,
    privateKey: TEST_PRIVATE_KEY,
    llm: TEST_MODEL,
    createWebhooks: (options) => new FakeWebhooks(options) as unknown as never,
  });
  eventHandler.getToken = async () => MOCK_TOKEN;

  const fakeEvent = issueCommentCreatedEvent("/foo");
  eventHandler.transformEvent = () =>
    ({
      id: "state_1",
      key: "issue_comment.created",
      octokit: {},
      eventHandler,
      payload: fakeEvent.payload,
      logger,
    }) as never;

  const dispatches: Array<{ plugin: string; eventName: string }> = [];

  let dispatchAttempt = 0;
  const deps: Partial<HandlerDeps> = {
    getKernelCommit: async () => "deadbeef",
    getConfig: async () =>
      ({
        plugins: {
          [pluginA]: { skipBotEvents: false, with: {} },
          [pluginB]: { skipBotEvents: false, with: {} },
        },
      }) as never,
    getPluginsForEvent: async (_context, _plugins, event) => {
      if (event === ("kernel.plugin_error" as never)) return [] as never;
      return [
        { key: pluginA, target: pluginA, settings: { skipBotEvents: false, with: {} } },
        { key: pluginB, target: pluginB, settings: { skipBotEvents: false, with: {} } },
      ] as never;
    },
    getManifest: async () => ({ name: "plugin" }) as never,
    resolvePluginDispatchTarget: async ({ plugin }) => ({ kind: "worker", targetUrl: String(plugin), ref: String(plugin) }) as never,
    dispatchPluginTarget: async ({ plugin, pluginInput }) => {
      dispatches.push({ plugin: typeof plugin === "string" ? plugin : `${plugin.owner}/${plugin.repo}`, eventName: String(pluginInput.eventName) });
      dispatchAttempt += 1;
      if (dispatchAttempt === 1) {
        throw new Error("Test induced first call failure");
      }
      return { target: { kind: "worker", targetUrl: "ok", ref: "ok" } } as never;
    },
  };

  bindHandlers(eventHandler, deps);
  await (eventHandler.webhooks as unknown as FakeWebhooks<unknown>).receive(fakeEvent);

  assertEquals(dispatches.length, 2);
  assertEquals(dispatches[0].plugin, pluginA);
  assertEquals(dispatches[1].plugin, pluginB);
});
