import { describe, expect, it } from "@jest/globals";
import { parseTelegramChannelConfig } from "../src/telegram/channel-config.ts";

const baseConfig = { plugins: {} } as const;

describe("telegram channel config", () => {
  it("defaults to shim when channels.telegram is missing", () => {
    const result = parseTelegramChannelConfig(baseConfig, "alice");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.mode).toBe("shim");
      expect(result.config.owner).toBe("alice");
    }
  });

  it("rejects invalid mode", () => {
    const result = parseTelegramChannelConfig(
      {
        ...baseConfig,
        channels: { telegram: { mode: "invalid", repo: "test", issueNumber: 1 } },
      },
      "alice"
    );
    expect(result.ok).toBe(false);
  });

  it("requires repo + issueNumber in github mode", () => {
    const missingRepo = parseTelegramChannelConfig(
      {
        ...baseConfig,
        channels: { telegram: { issueNumber: 1 } },
      },
      "alice"
    );
    expect(missingRepo.ok).toBe(false);

    const missingIssue = parseTelegramChannelConfig(
      {
        ...baseConfig,
        channels: { telegram: { repo: "repo" } },
      },
      "alice"
    );
    expect(missingIssue.ok).toBe(false);
  });

  it("defaults owner to linked identity", () => {
    const result = parseTelegramChannelConfig(
      {
        ...baseConfig,
        channels: { telegram: { repo: "repo", issueNumber: 12 } },
      },
      "alice"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.owner).toBe("alice");
    }
  });

  it("allows shim mode without repo/issue", () => {
    const result = parseTelegramChannelConfig(
      {
        ...baseConfig,
        channels: { telegram: { mode: "shim" } },
      },
      "alice"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.mode).toBe("shim");
    }
  });
});
