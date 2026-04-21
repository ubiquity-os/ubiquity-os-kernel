import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { assertEquals } from "jsr:@std/assert";

import { GitHubEventHandler } from "../src/github/github-event-handler.ts";
import { bindHandlers, type HandlerDeps } from "../src/github/handlers/index.ts";
import { FakeWebhooks } from "./test-utils/fake-webhooks.ts";

const TEST_APP_ID = "1";
const TEST_PRIVATE_KEY = "test-private-key";
const TEST_WEBHOOK_SECRET = "test-secret";
const TEST_MODEL = "test-model";
const MOCK_TOKEN = "mock-token";
let nextEventCommentId = 100;
const testLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  github: () => {},
};

function issueCommentCreatedEvent(commentBody: string, authorType: "User" | "Bot" = "User"): EmitterWebhookEvent {
  const login = authorType === "User" ? "test-user" : "ubiquity-os-beta[bot]";
  const commentId = nextEventCommentId++;
  return {
    id: "evt_1",
    name: "issue_comment",
    payload: {
      action: "created",
      installation: { id: 1 },
      sender: { login, type: authorType },
      comment: {
        id: commentId,
        body: commentBody,
        user: { login, type: authorType },
        html_url: `https://github.com/test-user/test-repo/issues/1#issuecomment-${commentId}`,
      },
      issue: {
        number: 1,
        user: { login: "test-user" },
        html_url: "https://github.com/test-user/test-repo/issues/1",
      },
      repository: {
        id: 123,
        name: "test-repo",
        full_name: "test-user/test-repo",
        owner: { login: "test-user", id: 456 },
      },
    },
  } as EmitterWebhookEvent;
}

function pullRequestReviewCommentCreatedEvent(commentBody: string, authorType: "User" | "Bot" = "User"): EmitterWebhookEvent {
  const login = authorType === "User" ? "test-user" : "ubiquity-os-beta[bot]";
  const commentId = nextEventCommentId++;
  return {
    id: "evt_review_1",
    name: "pull_request_review_comment",
    payload: {
      action: "created",
      installation: { id: 1 },
      sender: { login, type: authorType },
      comment: {
        id: commentId,
        body: commentBody,
        user: { login, type: authorType },
        html_url: `https://github.com/test-user/test-repo/pull/1#discussion_r${commentId}`,
      },
      pull_request: {
        number: 1,
        title: "Test PR",
        body: "PR body",
        html_url: "https://github.com/test-user/test-repo/pull/1",
        labels: [],
        user: { login: "test-user" },
      },
      repository: {
        id: 123,
        name: "test-repo",
        full_name: "test-user/test-repo",
        owner: { login: "test-user", id: 456 },
      },
    },
  } as unknown as EmitterWebhookEvent;
}

function getEventKey(event: EmitterWebhookEvent): string {
  if (event.name === "issue_comment") return "issue_comment.created";
  if (event.name === "pull_request_review_comment") {
    return "pull_request_review_comment.created";
  }
  return `${event.name}.${String((event.payload as { action?: unknown }).action ?? "")}`;
}

function createEventHandler() {
  const eventHandler = new GitHubEventHandler({
    environment: "production",
    webhookSecret: TEST_WEBHOOK_SECRET,
    appId: TEST_APP_ID,
    privateKey: TEST_PRIVATE_KEY,
    llm: TEST_MODEL,
    logger: testLogger as never,
    createWebhooks: (options) => new FakeWebhooks(options) as unknown as never,
  });
  eventHandler.getToken = async () => MOCK_TOKEN;
  eventHandler.transformEvent = (event) =>
    ({
      id: "state_1",
      key: getEventKey(event),
      octokit: {},
      eventHandler,
      payload: event.payload,
      logger: testLogger,
    }) as never;
  return eventHandler;
}

function createDispatchDeps(dispatches: Array<{ plugin: string; eventName: string }>, options?: { throwOnFirstDispatch?: boolean }): Partial<HandlerDeps> {
  const pluginA = "https://plugin-a.internal";
  const pluginB = "https://plugin-b.internal";
  let dispatchAttempt = 0;
  return {
    getKernelCommit: async () => "deadbeef",
    getConfig: async () =>
      ({
        plugins: {
          [pluginA]: { skipBotEvents: false, with: {} },
          [pluginB]: { skipBotEvents: false, with: {} },
        },
      }) as never,
    getPluginsForEvent: async (context, plugins, event) => {
      void context;
      void plugins;
      if (event === ("kernel.plugin_error" as never)) return [] as never;
      return [
        {
          key: pluginA,
          target: pluginA,
          settings: { skipBotEvents: false, with: {} },
        },
        {
          key: pluginB,
          target: pluginB,
          settings: { skipBotEvents: false, with: {} },
        },
      ] as never;
    },
    getManifest: async () => ({ name: "plugin" }) as never,
    resolvePluginDispatchTarget: async ({ plugin }) =>
      ({
        kind: "worker",
        targetUrl: String(plugin),
        ref: String(plugin),
      }) as never,
    dispatchPluginTarget: async ({ plugin, pluginInput }) => {
      dispatches.push({
        plugin: typeof plugin === "string" ? plugin : `${plugin.owner}/${plugin.repo}`,
        eventName: String(pluginInput.eventName),
      });
      dispatchAttempt += 1;
      if (options?.throwOnFirstDispatch && dispatchAttempt === 1) {
        throw new Error("Test induced first call failure");
      }
      return {
        target: { kind: "worker", targetUrl: "ok", ref: "ok" },
      } as never;
    },
  };
}

Deno.test("handleEvent: continues dispatching plugins if one throws", async () => {
  const pluginA = "https://plugin-a.internal";
  const pluginB = "https://plugin-b.internal";

  const eventHandler = createEventHandler();
  const fakeEvent = issueCommentCreatedEvent("/foo");
  const dispatches: Array<{ plugin: string; eventName: string }> = [];
  const deps = createDispatchDeps(dispatches, { throwOnFirstDispatch: true });

  bindHandlers(eventHandler, deps);
  await (eventHandler.webhooks as unknown as FakeWebhooks<unknown>).receive(fakeEvent);

  assertEquals(dispatches.length, 2);
  assertEquals(dispatches[0].plugin, pluginA);
  assertEquals(dispatches[1].plugin, pluginB);
});

Deno.test("handleEvent: skips global dispatch for bot-authored command-response issue comments", async () => {
  const eventHandler = createEventHandler();
  const fakeEvent = issueCommentCreatedEvent('| `/query` | `/query @UbiquityOS` |\n\n<!-- "commentKind": "command-response" -->', "Bot");
  const dispatches: Array<{ plugin: string; eventName: string }> = [];

  bindHandlers(eventHandler, createDispatchDeps(dispatches));
  await (eventHandler.webhooks as unknown as FakeWebhooks<unknown>).receive(fakeEvent);

  assertEquals(dispatches.length, 0);
});

Deno.test("handleEvent: skips global dispatch for bot-authored invocation issue comments", async () => {
  const eventHandler = createEventHandler();
  const fakeEvent = issueCommentCreatedEvent("@ubiquityos agent implement this", "Bot");
  const dispatches: Array<{ plugin: string; eventName: string }> = [];

  bindHandlers(eventHandler, createDispatchDeps(dispatches));
  await (eventHandler.webhooks as unknown as FakeWebhooks<unknown>).receive(fakeEvent);

  assertEquals(dispatches.length, 0);
});

Deno.test("handleEvent: still dispatches generic bot issue comments when plugins allow bot events", async () => {
  const eventHandler = createEventHandler();
  const fakeEvent = issueCommentCreatedEvent("Build finished successfully.", "Bot");
  const dispatches: Array<{ plugin: string; eventName: string }> = [];

  bindHandlers(eventHandler, createDispatchDeps(dispatches));
  await (eventHandler.webhooks as unknown as FakeWebhooks<unknown>).receive(fakeEvent);

  assertEquals(dispatches.length, 2);
});

Deno.test("handleEvent: skips global dispatch for bot-authored invocation review comments", async () => {
  const eventHandler = createEventHandler();
  const fakeEvent = pullRequestReviewCommentCreatedEvent("@ubiquityos agent implement this", "Bot");
  const dispatches: Array<{ plugin: string; eventName: string }> = [];

  bindHandlers(eventHandler, createDispatchDeps(dispatches));
  await (eventHandler.webhooks as unknown as FakeWebhooks<unknown>).receive(fakeEvent);

  assertEquals(dispatches.length, 0);
});
