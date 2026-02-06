import { assert, assertEquals } from "jsr:@std/assert";
import { parseTelegramChannelConfig } from "../src/telegram/channel-config.ts";

const baseConfig = { plugins: {} } as const;

Deno.test("telegram channel config: defaults to shim when channels.telegram is missing", () => {
  const result = parseTelegramChannelConfig(baseConfig, "alice");
  assert(result.ok);
  if (!result.ok) return;

  assertEquals(result.config.mode, "shim");
  assertEquals(result.config.owner, "alice");
});

Deno.test("telegram channel config: rejects invalid mode", () => {
  const result = parseTelegramChannelConfig(
    {
      ...baseConfig,
      channels: { telegram: { mode: "invalid", repo: "test", issueNumber: 1 } },
    },
    "alice"
  );
  assertEquals(result.ok, false);
});

Deno.test("telegram channel config: requires repo + issueNumber in github mode", () => {
  const missingRepo = parseTelegramChannelConfig(
    {
      ...baseConfig,
      channels: { telegram: { issueNumber: 1 } },
    },
    "alice"
  );
  assertEquals(missingRepo.ok, false);

  const missingIssue = parseTelegramChannelConfig(
    {
      ...baseConfig,
      channels: { telegram: { repo: "repo" } },
    },
    "alice"
  );
  assertEquals(missingIssue.ok, false);
});

Deno.test("telegram channel config: defaults owner to linked identity", () => {
  const result = parseTelegramChannelConfig(
    {
      ...baseConfig,
      channels: { telegram: { repo: "repo", issueNumber: 12 } },
    },
    "alice"
  );
  assert(result.ok);
  if (!result.ok) return;

  assertEquals(result.config.owner, "alice");
});

Deno.test("telegram channel config: allows shim mode without repo/issue", () => {
  const result = parseTelegramChannelConfig(
    {
      ...baseConfig,
      channels: { telegram: { mode: "shim" } },
    },
    "alice"
  );
  assert(result.ok);
  if (!result.ok) return;

  assertEquals(result.config.mode, "shim");
});
