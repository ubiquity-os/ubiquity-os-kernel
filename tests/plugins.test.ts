import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { EmitterWebhookEventName } from "@octokit/webhooks";
import { GitHubContext } from "../src/github/github-context";
import { ResolvedPlugin, shouldSkipPlugin } from "../src/github/utils/plugins";
import { logger } from "../src/logger/logger";
import { server } from "./__mocks__/node";

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
  jest.clearAllMocks();
  jest.resetAllMocks();
  jest.resetModules();
});
afterAll(() => {
  server.close();
});

describe("Plugin tests", () => {
  it("Should skip plugins if needed", async () => {
    const pluginAddress = "http://localhost";
    const issueCommentCreated = "issue_comment.created";
    const pullRequestOpened = "pull_request.opened";
    const basePlugin: ResolvedPlugin = {
      key: pluginAddress,
      target: pluginAddress,
      settings: {
        skipBotEvents: true,
        runsOn: [],
        with: {},
      },
    };
    function pluginWithRunsOn(runsOn: EmitterWebhookEventName[]): ResolvedPlugin {
      return {
        key: basePlugin.key,
        target: basePlugin.target,
        settings: {
          with: basePlugin.settings?.with ?? {},
          skipBotEvents: basePlugin.settings?.skipBotEvents,
          runsOn,
        },
      };
    }

    // Skip bot comment
    await expect(
      shouldSkipPlugin(
        {
          payload: {
            sender: {
              type: "Bot",
            },
          },
          logger,
        } as unknown as GitHubContext,
        basePlugin,
        issueCommentCreated
      )
    ).resolves.toBe(true);

    // Skipping because the plugin doesn't listen to the event
    await expect(
      shouldSkipPlugin(
        {
          key: issueCommentCreated,
          payload: {
            sender: {
              type: "User",
            },
          },
          logger,
        } as unknown as GitHubContext,
        basePlugin,
        issueCommentCreated
      )
    ).resolves.toBe(true);

    // Not skipping when runsOn matches the event
    await expect(
      shouldSkipPlugin(
        {
          key: issueCommentCreated,
          payload: {
            sender: {
              type: "User",
            },
          },
          logger,
        } as unknown as GitHubContext,
        pluginWithRunsOn([issueCommentCreated]),
        issueCommentCreated
      )
    ).resolves.toBe(false);

    // Not skipping matching listener
    await expect(
      shouldSkipPlugin(
        {
          key: pullRequestOpened,
          payload: {
            sender: {
              type: "User",
            },
          },
          logger,
        } as unknown as GitHubContext,
        pluginWithRunsOn([pullRequestOpened]),
        pullRequestOpened
      )
    ).resolves.toBe(false);

    // Skipping non-matching listener
    await expect(
      shouldSkipPlugin(
        {
          key: "pull_request.closed",
          payload: {
            sender: {
              type: "User",
            },
          },
          logger,
        } as unknown as GitHubContext,
        pluginWithRunsOn([pullRequestOpened]),
        "pull_request.closed"
      )
    ).resolves.toBe(true);
  });
});
