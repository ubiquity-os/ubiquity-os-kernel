import { EmitterWebhookEventName } from "@octokit/webhooks";
import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  SdkStyleEventHandlers,
  type EventHandlerFn,
  type HandlerDescriptor,
  resolveInvocationType,
} from "../src/github/utils/sdk-style-handlers.ts";

/**
 * Mock GitHubContext for testing
 */
function createMockHandler(): EventHandlerFn {
  return async () => {};
}

Deno.test("SdkStyleEventHandlers: on() registers handlers and returns self for chaining", () => {
  const handlers = new SdkStyleEventHandlers();
  const handler1 = createMockHandler();
  const handler2 = createMockHandler();

  const result = handlers.on("issue_comment.created", "action", handler1).on("issue.closed", "worker", handler2);

  assertEquals(result === handlers, true);
  assertEquals(handlers.handlers.length, 2);
  assertEquals(handlers.handlers[0].event, "issue_comment.created");
  assertEquals(handlers.handlers[0].invocationType, "action");
  assertEquals(handlers.handlers[1].event, "issue.closed");
  assertEquals(handlers.handlers[1].invocationType, "worker");
});

Deno.test("SdkStyleEventHandlers: action() shorthand registers action handlers", () => {
  const handlers = new SdkStyleEventHandlers();
  const handler = createMockHandler();

  handlers.action("push", handler);

  assertEquals(handlers.handlers.length, 1);
  assertEquals(handlers.handlers[0].event, "push");
  assertEquals(handlers.handlers[0].invocationType, "action");
});

Deno.test("SdkStyleEventHandlers: worker() shorthand registers worker handlers", () => {
  const handlers = new SdkStyleEventHandlers();
  const handler = createMockHandler();

  handlers.worker("pull_request.opened", handler);

  assertEquals(handlers.handlers.length, 1);
  assertEquals(handlers.handlers[0].event, "pull_request.opened");
  assertEquals(handlers.handlers[0].invocationType, "worker");
});

Deno.test("SdkStyleEventHandlers: auto() shorthand registers auto handlers", () => {
  const handlers = new SdkStyleEventHandlers();
  const handler = createMockHandler();

  handlers.auto("issue.opened", handler);

  assertEquals(handlers.handlers.length, 1);
  assertEquals(handlers.handlers[0].event, "issue.opened");
  assertEquals(handlers.handlers[0].invocationType, "auto");
});

Deno.test("SdkStyleEventHandlers: chaining multiple handlers", () => {
  const handlers = new SdkStyleEventHandlers()
    .action("issue_comment.created", createMockHandler())
    .worker("issue.closed", createMockHandler())
    .auto("push", createMockHandler());

  assertEquals(handlers.handlers.length, 3);
  assertEquals(handlers.handlers[0].invocationType, "action");
  assertEquals(handlers.handlers[1].invocationType, "worker");
  assertEquals(handlers.handlers[2].invocationType, "auto");
});

Deno.test("SdkStyleEventHandlers: getHandlersForEvent() returns filtered handlers", () => {
  const handlers = new SdkStyleEventHandlers()
    .on("issue_comment.created", "action", createMockHandler())
    .on("issue_comment.created", "worker", createMockHandler())
    .on("issue.closed", "action", createMockHandler());

  const commentHandlers = handlers.getHandlersForEvent("issue_comment.created");
  assertEquals(commentHandlers.length, 2);
  assertEquals(commentHandlers[0].invocationType, "action");
  assertEquals(commentHandlers[1].invocationType, "worker");

  const closedHandlers = handlers.getHandlersForEvent("issue.closed");
  assertEquals(closedHandlers.length, 1);
  assertEquals(closedHandlers[0].invocationType, "action");
});

Deno.test("SdkStyleEventHandlers: getHandlersForEvent() returns empty for non-existent event", () => {
  const handlers = new SdkStyleEventHandlers().on("push", "action", createMockHandler());

  const result = handlers.getHandlersForEvent("issue_comment.created");
  assertEquals(result.length, 0);
});

Deno.test("SdkStyleEventHandlers: isEmpty returns correct state", () => {
  const emptyHandlers = new SdkStyleEventHandlers();
  assertEquals(emptyHandlers.isEmpty, true);

  emptyHandlers.on("push", "action", createMockHandler());
  assertEquals(emptyHandlers.isEmpty, false);
});

Deno.test("SdkStyleEventHandlers: merge() combines handlers from another instance", () => {
  const handlers1 = new SdkStyleEventHandlers().on("push", "action", createMockHandler());
  const handlers2 = new SdkStyleEventHandlers()
    .on("issue.opened", "worker", createMockHandler())
    .on("issue.closed", "auto", createMockHandler());

  handlers1.merge(handlers2);

  assertEquals(handlers1.handlers.length, 3);
  assertEquals(handlers1.handlers[0].event, "push");
  assertEquals(handlers1.handlers[1].event, "issue.opened");
  assertEquals(handlers1.handlers[2].event, "issue.closed");
});

Deno.test("SdkStyleEventHandlers: toManifestData() generates correct manifest structure", () => {
  const handlers = new SdkStyleEventHandlers()
    .on("issue_comment.created", "action", createMockHandler())
    .on("issue.closed", "worker", createMockHandler())
    .on("push", "auto", createMockHandler());

  const manifest = handlers.toManifestData();

  assertEquals(manifest.events.includes("issue_comment.created"), true);
  assertEquals(manifest.events.includes("issue.closed"), true);
  assertEquals(manifest.events.includes("push"), true);
  assertEquals(manifest.invocationTypes["issue_comment.created"], "action");
  assertEquals(manifest.invocationTypes["issue.closed"], "worker");
  assertEquals(manifest.invocationTypes["push"], "auto");
});

Deno.test("SdkStyleEventHandlers: toManifestData() uses most specific invocation type", () => {
  const handlers = new SdkStyleEventHandlers()
    .on("issue.opened", "action", createMockHandler())
    .on("issue.opened", "auto", createMockHandler());

  const manifest = handlers.toManifestData();

  // Should prefer action over auto when multiple handlers for same event
  assertEquals(manifest.invocationTypes["issue.opened"], "action");
});

Deno.test("resolveInvocationType: prefers handler-specified type over manifest", () => {
  const manifest = { homepage_url: "https://worker.example" };
  const handlers: HandlerDescriptor[] = [
    { event: "issue_comment.created", invocationType: "action", handler: createMockHandler() },
  ];

  const result = resolveInvocationType(manifest, "issue_comment.created", handlers);

  assertEquals(result, "action");
});

Deno.test("resolveInvocationType: falls back to worker when manifest has homepage_url", () => {
  const manifest = { homepage_url: "https://worker.example" };
  const handlers: HandlerDescriptor[] = [
    { event: "issue_comment.created", invocationType: "auto", handler: createMockHandler() },
  ];

  const result = resolveInvocationType(manifest, "issue_comment.created", handlers);

  assertEquals(result, "worker");
});

Deno.test("resolveInvocationType: defaults to action when no manifest and auto handlers", () => {
  const manifest = null;
  const handlers: HandlerDescriptor[] = [
    { event: "push", invocationType: "auto", handler: createMockHandler() },
  ];

  const result = resolveInvocationType(manifest, "push", handlers);

  assertEquals(result, "action");
});

Deno.test("resolveInvocationType: returns worker when manifest has homepage_url and no handlers", () => {
  const manifest = { homepage_url: "https://worker.example" };
  const handlers: HandlerDescriptor[] = [];

  const result = resolveInvocationType(manifest, "push", handlers);

  assertEquals(result, "worker");
});

Deno.test("SdkStyleEventHandlers: preserves handler function reference", () => {
  const customHandler = async () => {
    throw new Error("test");
  };

  const handlers = new SdkStyleEventHandlers().on("issue_comment.created", "action", customHandler);

  const registeredHandler = handlers.handlers[0].handler;
  assertEquals(registeredHandler === customHandler, true);
});

Deno.test("SdkStyleEventHandlers: supports all EmitterWebhookEventName values", () => {
  const handlers = new SdkStyleEventHandlers();

  // Test a variety of events
  handlers.on("push", "action", createMockHandler());
  handlers.on("pull_request.opened", "worker", createMockHandler());
  handlers.on("issue_comment.created", "auto", createMockHandler());
  handlers.on("release.published", "action", createMockHandler());
  handlers.on("workflow_run.completed", "worker", createMockHandler());

  assertEquals(handlers.handlers.length, 5);
  assertEquals(handlers.handlers[0].event, "push");
  assertEquals(handlers.handlers[1].event, "pull_request.opened");
  assertEquals(handlers.handlers[2].event, "issue_comment.created");
  assertEquals(handlers.handlers[3].event, "release.published");
  assertEquals(handlers.handlers[4].event, "workflow_run.completed");
});

Deno.test("SdkStyleEventHandlers: readonly handlers property", () => {
  const handlers = new SdkStyleEventHandlers().on("push", "action", createMockHandler());

  // Type check - handlers should be ReadonlyArray
  const readonlyHandlers: ReadonlyArray<HandlerDescriptor> = handlers.handlers;
  assertEquals(readonlyHandlers.length, 1);

  // Mutation should not be possible on the exposed array
  // Note: This is a shallow check; TypeScript enforces this at compile time
});