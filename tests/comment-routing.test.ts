import { assertEquals } from "jsr:@std/assert";

import { extractAfterUbiquityosMention, getCreatedCommentRouteContext, shouldSkipBotInvocationDispatch } from "../src/github/utils/comment-routing.ts";

Deno.test("extractAfterUbiquityosMention: only matches explicit leading mention", () => {
  assertEquals(extractAfterUbiquityosMention("@ubiquityos agent fix this"), "agent fix this");
  assertEquals(extractAfterUbiquityosMention("   @ubiquityos /help"), "/help");
  assertEquals(extractAfterUbiquityosMention("See `/query @UbiquityOS` in the help output"), null);
});

Deno.test("getCreatedCommentRouteContext: command-response output is not treated as explicit invocation", () => {
  const routeContext = getCreatedCommentRouteContext(
    ["| Command | Example |", "|---|---|", "| `/query` | `/query @UbiquityOS` |", "", '<!-- "commentKind": "command-response" -->'].join("\n"),
    "Bot"
  );

  assertEquals(routeContext.afterMention, null);
  assertEquals(routeContext.slashInvocation, null);
  assertEquals(routeContext.isExplicitInvocation, false);
  assertEquals(routeContext.isCommandResponse, true);
});

Deno.test("shouldSkipBotInvocationDispatch: blocks bot invocations but not generic bot activity", () => {
  assertEquals(shouldSkipBotInvocationDispatch("@ubiquityos agent implement this", "Bot"), true);
  assertEquals(shouldSkipBotInvocationDispatch("/help", "Bot"), true);
  assertEquals(shouldSkipBotInvocationDispatch("Build finished successfully.", "Bot"), false);
});
