import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PluginBuilder, createPluginBuilder } from "../src/github/plugin-builder.ts";
import { resolveHandlerType, detectActionRef } from "../src/github/types/handler.ts";

Deno.test("PluginBuilder - registers action handler", () => {
  const handler = () => {};
  const plugin = new PluginBuilder("test-plugin")
    .on("issue_comment.created", "action", handler, { actionRef: "owner/repo/workflow.yml@main" })
    .build();

  assertEquals(plugin.handlers.length, 1);
  assertEquals(plugin.handlers[0].event, "issue_comment.created");
  assertEquals(plugin.handlers[0].type, "action");
  assertEquals(plugin.handlers[0].actionRef, "owner/repo/workflow.yml@main");
});

Deno.test("PluginBuilder - registers worker handler", () => {
  const handler = () => {};
  const plugin = new PluginBuilder("test-plugin")
    .on("issues.opened", "worker", handler)
    .build();

  assertEquals(plugin.handlers.length, 1);
  assertEquals(plugin.handlers[0].event, "issues.opened");
  assertEquals(plugin.handlers[0].type, "worker");
  assertEquals(plugin.handlers[0].actionRef, undefined);
});

Deno.test("PluginBuilder - fluent API chains multiple handlers", () => {
  const handler1 = () => {};
  const handler2 = () => {};
  const plugin = new PluginBuilder("hybrid-plugin")
    .on("issue_comment.created", "action", handler1)
    .on("issues.opened", "worker", handler2)
    .build();

  assertEquals(plugin.handlers.length, 2);
  assertEquals(plugin.handlers[0].type, "action");
  assertEquals(plugin.handlers[1].type, "worker");
});

Deno.test("PluginBuilder - convenience methods", () => {
  const handler = () => {};
  const plugin = new PluginBuilder("test")
    .onAction("push", handler, { actionRef: "o/r/w@main" })
    .onWorker("pull_request.opened", handler)
    .build();

  assertEquals(plugin.handlers.length, 2);
  assertEquals(plugin.handlers[0].type, "action");
  assertEquals(plugin.handlers[1].type, "worker");
});

Deno.test("PluginBuilder - auto-detect type from ACTION_REF env", () => {
  const original = Deno.env.get("ACTION_REF");
  Deno.env.set("ACTION_REF", "owner/repo/workflow.yml@main");
  try {
    const handler = () => {};
    const plugin = new PluginBuilder("test")
      .on("issues.opened", undefined as any, handler)
      .build();

    assertEquals(plugin.handlers[0].type, "action");
    assertEquals(plugin.handlers[0].actionRef, "owner/repo/workflow.yml@main");
  } finally {
    if (original === undefined) {
      Deno.env.delete("ACTION_REF");
    } else {
      Deno.env.set("ACTION_REF", original);
    }
  }
});

Deno.test("PluginBuilder - defaults to worker when no ACTION_REF", () => {
  const original = Deno.env.get("ACTION_REF");
  Deno.env.delete("ACTION_REF");
  try {
    const handler = () => {};
    const plugin = new PluginBuilder("test")
      .on("issues.opened", undefined as any, handler)
      .build();

    assertEquals(plugin.handlers[0].type, "worker");
  } finally {
    if (original !== undefined) {
      Deno.env.set("ACTION_REF", original);
    }
  }
});

Deno.test("PluginBuilder - overrides overwrite same event", () => {
  const h1 = () => {};
  const h2 = () => {};
  const plugin = new PluginBuilder("test")
    .on("issues.opened", "worker", h1)
    .on("issues.opened", "action", h2)
    .build();

  assertEquals(plugin.handlers.length, 1);
  assertEquals(plugin.handlers[0].type, "action");
});

Deno.test("createPluginBuilder - creates PluginBuilder instance", () => {
  const builder = createPluginBuilder("my-plugin");
  assertEquals(builder.name, "my-plugin");
  assertEquals(builder.handlers.size, 0);
});

Deno.test("resolveHandlerType - explicit type takes precedence", () => {
  assertEquals(resolveHandlerType("test", "action"), "action");
  assertEquals(resolveHandlerType("test", "worker"), "worker");
});

Deno.test("detectActionRef - returns undefined when not set", () => {
  const original = Deno.env.get("ACTION_REF");
  Deno.env.delete("ACTION_REF");
  try {
    assertEquals(detectActionRef(), undefined);
  } finally {
    if (original !== undefined) {
      Deno.env.set("ACTION_REF", original);
    }
  }
});

Deno.test("PluginBuilder - fine-grained token support", () => {
  const handler = () => {};
  const plugin = new PluginBuilder("test")
    .on("issues.opened", "action", handler, { token: "ghp_fine_grained_token" })
    .build();

  assertEquals(plugin.handlers[0].token, "ghp_fine_grained_token");
});
