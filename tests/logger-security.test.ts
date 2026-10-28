import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert";
import { GitHubEventHandler } from "../src/github/github-event-handler.ts";
import { bindHandlers } from "../src/github/handlers/index.ts";
import { logger } from "../src/logger/logger.ts";

const PRIVATE_KEY = "uos-test-private-key-sentinel";
const WEBHOOK_SECRET = "uos-test-webhook-secret-sentinel";
const AI_TOKEN = "uos-test-ai-token-sentinel";
const DELIVERY_ID = "uos-log-test-delivery";
const REPOSITORY = "test-owner/test-repo";
const ERROR_MESSAGE = "KV write quota exceeded";
const credentials = { _privateKey: PRIVATE_KEY, _webhookSecret: WEBHOOK_SECRET, aiToken: AI_TOKEN };

async function captureLogs(action: () => unknown | Promise<unknown>) {
  const lines: string[] = [];
  const methods = ["error", "warn", "info", "log"] as const;
  const originals = methods.map((method) => console[method]);
  try {
    for (const method of methods) console[method] = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    await action();
  } finally {
    methods.forEach((method, index) => (console[method] = originals[index]));
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertNoCredentials(logs: unknown) {
  const text = JSON.stringify(logs);
  for (const secret of [PRIVATE_KEY, WEBHOOK_SECRET, AI_TOKEN]) assertEquals(text.includes(secret), false);
  assertEquals(text.includes(WEBHOOK_SECRET.slice(0, 10)), false);
}

function createHandler() {
  return new GitHubEventHandler({
    environment: "logger-security-test",
    appId: "1",
    privateKey: PRIVATE_KEY,
    webhookSecret: WEBHOOK_SECRET,
    aiToken: AI_TOKEN,
    llm: "test-model",
    logger: logger.child({}, { level: "trace" }),
  });
}

function openedEvent(): EmitterWebhookEvent {
  return {
    id: DELIVERY_ID,
    name: "issues",
    payload: {
      action: "opened",
      repository: { full_name: REPOSITORY, name: "test-repo", owner: { login: "test-owner" } },
      issue: { number: 1 },
      sender: { login: "test-user", type: "User" },
    },
  } as EmitterWebhookEvent;
}

Deno.test("logger keeps useful error fields without serializing attached runtime context", async () => {
  const error = Object.assign(new Error(ERROR_MESSAGE), {
    context: { eventHandler: credentials },
    request: { headers: { authorization: AI_TOKEN } },
  });
  const logs = await captureLogs(() => {
    logger.error(error, "Uncaught error");
    logger.error({ err: error, event: "issues", deliveryId: DELIVERY_ID, repository: REPOSITORY }, "Handler failed");
    logger.error(new AggregateError([error], "Webhook handlers failed"), "Uncaught aggregate error");
    logger.child({ requestId: DELIVERY_ID }).error({ err: error }, "Child handler failed");
  });
  assertNoCredentials(logs);
  const detail = logs[0].err as Record<string, unknown>;
  assertEquals(detail.type, "Error");
  assertEquals(detail.message, ERROR_MESSAGE);
  assertStringIncludes(String(detail.stack), ERROR_MESSAGE);
  assertEquals(logs[1].deliveryId, DELIVERY_ID);
  const aggregate = logs[2].err as { errors?: Array<{ message?: string }> };
  assertEquals(aggregate.errors?.[0].message, ERROR_MESSAGE);
  assertEquals(logs[3].requestId, DELIVERY_ID);
  assertEquals((logs[3].err as { message?: string }).message, ERROR_MESSAGE);
});

Deno.test("handler failure logs identify the transformed event without its runtime context", async () => {
  const handler = createHandler();
  bindHandlers(handler, {
    getConfig: () => Promise.reject(new Error(ERROR_MESSAGE)),
  });
  const logs = await captureLogs(() => handler.webhooks.receive(openedEvent()));
  assertNoCredentials(logs);
  const failure = logs.find((entry) => entry.msg === "Error in event handler");
  assertExists(failure);
  assertEquals(failure.event, "issues");
  assertEquals(failure.deliveryId, DELIVERY_ID);
  assertEquals(failure.repository, REPOSITORY);
  assertEquals((failure.err as { message?: string }).message, ERROR_MESSAGE);
});

Deno.test("webhook errors never log a webhook secret prefix", async () => {
  const handler = createHandler();
  handler.on("issues", () => {
    throw new Error("Test webhook handler failed");
  });
  const logs = await captureLogs(async () => {
    try {
      await handler.webhooks.receive(openedEvent());
    } catch {
      // Octokit rejects after notifying its error handlers.
    }
  });
  assertNoCredentials(logs);
  const failure = logs.find((entry) => entry.msg === "Webhook error - check secret match");
  assertExists(failure);
  assertStringIncludes(JSON.stringify(failure.err), "Test webhook handler failed");
});
