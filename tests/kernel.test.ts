import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { assertEquals } from "jsr:@std/assert";

import { GitHubEventHandler } from "../src/github/github-event-handler.ts";
import { bindHandlers, type HandlerDeps } from "../src/github/handlers/index.ts";
import { logger } from "../src/logger/logger.ts";
import { FakeWebhooks } from "./test-utils/fake-webhooks.ts";

const TEST_ENVIRONMENT = "development";
const TEST_ORG = "0x4007";
const TEST_REPO = "ubiquity-os-sandbox";
const TEST_WORKER_URL = "http://127.0.0.1:9090";
const MOCK_TOKEN = "mock-token";

const TEST_APP_ID = "12345";
const TEST_PRIVATE_KEY = "test-private-key";
const TEST_WEBHOOK_SECRET = "test-secret";
const TEST_MODEL = "test-model";
const ISSUE_COMMENT_CREATED = "issue_comment.created";

function createFakeIssueCommentCreatedEvent({ org, repo, commentBody }: { org: string; repo: string; commentBody: string }): EmitterWebhookEvent {
  return {
    id: "test-event-id",
    name: "issue_comment",
    payload: {
      action: "created",
      repository: {
        owner: { login: org },
        name: repo,
        full_name: `${org}/${repo}`,
      },
      issue: {
        number: 1,
        html_url: `https://github.com/${org}/${repo}/issues/1`,
      },
      comment: {
        id: 123,
        body: commentBody,
        html_url: `https://github.com/${org}/${repo}/issues/1#issuecomment-123`,
        user: {
          login: "testuser",
          type: "Bot",
        },
      },
      installation: {
        id: 12345,
      },
      sender: {
        login: "testuser",
        type: "Bot",
      },
    },
  } as EmitterWebhookEvent;
}

Deno.test("Kernel: dispatches configured worker plugins via onAny pipeline", async () => {
  const eventHandler = new GitHubEventHandler({
    environment: TEST_ENVIRONMENT,
    webhookSecret: TEST_WEBHOOK_SECRET,
    appId: TEST_APP_ID,
    privateKey: TEST_PRIVATE_KEY,
    llm: TEST_MODEL,
    createWebhooks: (options) => new FakeWebhooks(options) as unknown as never,
  });

  eventHandler.getToken = async () => MOCK_TOKEN;

  const fakeEvent = createFakeIssueCommentCreatedEvent({ org: TEST_ORG, repo: TEST_REPO, commentBody: "hello" });
  eventHandler.transformEvent = () =>
    ({
      id: "test-context-id",
      key: ISSUE_COMMENT_CREATED,
      octokit: {},
      eventHandler,
      payload: fakeEvent.payload,
      logger,
    }) as never;

  const dispatched: Array<{ targetUrl: string }> = [];

  const deps: Partial<HandlerDeps> = {
    getConfig: async () =>
      ({
        plugins: {
          [TEST_WORKER_URL]: {
            runsOn: [ISSUE_COMMENT_CREATED],
            skipBotEvents: false,
            with: {},
          },
        },
      }) as never,
    getPluginsForEvent: async () => [
      {
        key: TEST_WORKER_URL,
        target: TEST_WORKER_URL,
        settings: { runsOn: [ISSUE_COMMENT_CREATED], skipBotEvents: false, with: {} },
      } as never,
    ],
    resolvePluginDispatchTarget: async () => ({ kind: "worker", targetUrl: TEST_WORKER_URL, ref: TEST_WORKER_URL }) as never,
    dispatchPluginTarget: async ({ target }) => {
      dispatched.push({ targetUrl: (target as { targetUrl: string }).targetUrl });
      return { target, response: new Response(null, { status: 200 }) };
    },
  };

  bindHandlers(eventHandler, deps);

  await (eventHandler.webhooks as unknown as FakeWebhooks<unknown>).receive(fakeEvent);

  assertEquals(dispatched.length, 1);
  assertEquals(dispatched[0].targetUrl, TEST_WORKER_URL);
});
