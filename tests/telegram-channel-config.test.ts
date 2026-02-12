import { assert, assertEquals } from "jsr:@std/assert";
import { parseTelegramChannelConfig } from "../src/telegram/channel-config.ts";

const baseConfig = { plugins: {} } as const;

Deno.test("telegram channel config: requires channels.telegram or a fallback owner", () => {
  const result = parseTelegramChannelConfig(baseConfig);
  assertEquals(result.ok, false);
});

Deno.test("telegram channel config: defaults to shim when channels.telegram is missing", () => {
  const result = parseTelegramChannelConfig(baseConfig, {
    fallbackOwner: "alice",
  });
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.config.mode, "shim");
  assertEquals(result.config.owner, "alice");
});

Deno.test("telegram channel config: rejects invalid mode", () => {
  const result = parseTelegramChannelConfig({
    ...baseConfig,
    channels: {
      telegram: {
        mode: "invalid",
        owner: "alice",
        repo: "test",
        issueNumber: 1,
      },
    },
  });
  assertEquals(result.ok, false);
});

Deno.test("telegram channel config: requires repo + issueNumber in github mode", () => {
  const missingRepo = parseTelegramChannelConfig({
    ...baseConfig,
    channels: { telegram: { owner: "alice", issueNumber: 1 } },
  });
  assertEquals(missingRepo.ok, false);

  const missingIssue = parseTelegramChannelConfig({
    ...baseConfig,
    channels: { telegram: { owner: "alice", repo: "repo" } },
  });
  assertEquals(missingIssue.ok, false);
});

Deno.test("telegram channel config: requires owner", () => {
  const result = parseTelegramChannelConfig({
    ...baseConfig,
    channels: { telegram: { repo: "repo", issueNumber: 12 } },
  });
  assertEquals(result.ok, false);
});

Deno.test("telegram channel config: allows missing owner when fallback is provided", () => {
  const result = parseTelegramChannelConfig(
    {
      ...baseConfig,
      channels: { telegram: { mode: "shim" } },
    },
    { fallbackOwner: "alice" }
  );
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.config.owner, "alice");
});

Deno.test("telegram channel config: allows shim mode without repo/issue", () => {
  const result = parseTelegramChannelConfig({
    ...baseConfig,
    channels: { telegram: { mode: "shim", owner: "alice" } },
  });
  assert(result.ok);
  if (!result.ok) return;

  assertEquals(result.config.mode, "shim");
});
