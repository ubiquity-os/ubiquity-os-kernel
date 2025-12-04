import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EmitterWebhookEventName } from "@octokit/webhooks";
import { GitHubContext } from "../src/github/github-context";
import { ResolvedPlugin, shouldSkipPlugin } from "../src/github/utils/plugins";
import { logger } from "../src/logger/logger";

afterEach(() => {
  jest.clearAllMocks();
  jest.resetAllMocks();
  jest.resetModules();
});

describe("Plugin tests", () => {
  it("Should skip plugins if needed", async () => {
    const issueCommentCreated = "issue_comment.created";
    const pullRequestCommentCreated = "pull_request_review_comment.created";
    const pullRequestOpened = "pull_request.opened";
    const manifestMap: Record<string, unknown> = {
      "command-plugin": {
        name: "command",
        commands: {
          command: {
            description: "command",
            "ubiquity:example": "/command",
          },
        },
      },
      "listener-plugin": {
        name: "command",
        "ubiquity:listeners": [issueCommentCreated],
        commands: {
          command: {
            description: "command",
            "ubiquity:example": "/command",
          },
        },
      },
    };
    const getContent = jest.fn(async ({ repo }: { repo: string }) => {
      const manifest = manifestMap[repo];
      if (!manifest) {
        throw new Error(`No manifest for repo ${repo}`);
      }
      return {
        data: {
          content: Buffer.from(JSON.stringify(manifest)).toString("base64"),
        },
      };
    });
    const baseContext = {
      octokit: {
        rest: {
          repos: {
            getContent,
          },
        },
      },
      logger,
    } as Partial<GitHubContext>;

    const basePlugin: ResolvedPlugin = {
      key: "ubiquity/command-plugin",
      target: {
        owner: "ubiquity",
        repo: "command-plugin",
        workflowId: "compute.yml",
      },
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
    const listenerPlugin: ResolvedPlugin = {
      key: "ubiquity/listener-plugin",
      target: {
        owner: "ubiquity",
        repo: "listener-plugin",
        workflowId: "compute.yml",
      },
      settings: pluginWithRunsOn([issueCommentCreated]).settings,
    };

    // Skip bot comment
    await expect(
      shouldSkipPlugin(
        {
          ...baseContext,
          payload: {
            sender: {
              type: "Bot",
            },
          },
        } as unknown as GitHubContext,
        basePlugin,
        issueCommentCreated
      )
    ).resolves.toBe(true);

    // Skipping non-matching command
    await expect(
      shouldSkipPlugin(
        {
          ...baseContext,
          key: issueCommentCreated,
          payload: {
            sender: {
              type: "User",
            },
            comment: {
              body: "/wrong-command",
            },
          },
        } as unknown as GitHubContext,
        basePlugin,
        issueCommentCreated
      )
    ).resolves.toBe(true);

    // Not skipping matching command
    await expect(
      shouldSkipPlugin(
        {
          ...baseContext,
          key: issueCommentCreated,
          payload: {
            sender: {
              type: "User",
            },
            comment: {
              body: "/command",
            },
          },
        } as unknown as GitHubContext,
        basePlugin,
        issueCommentCreated
      )
    ).resolves.toBe(false);

    // Not skipping matching listener
    await expect(
      shouldSkipPlugin(
        {
          ...baseContext,
          key: pullRequestOpened,
          payload: {
            sender: {
              type: "User",
            },
          },
        } as unknown as GitHubContext,
        pluginWithRunsOn([pullRequestOpened]),
        pullRequestOpened
      )
    ).resolves.toBe(false);

    // Skipping non-matching listener
    await expect(
      shouldSkipPlugin(
        {
          ...baseContext,
          key: "pull_request.closed",
          payload: {
            sender: {
              type: "User",
            },
          },
        } as unknown as GitHubContext,
        pluginWithRunsOn([pullRequestOpened]),
        "pull_request.closed"
      )
    ).resolves.toBe(true);

    // Not skipping matching listener + command
    await expect(
      shouldSkipPlugin(
        {
          ...baseContext,
          key: pullRequestCommentCreated,
          payload: {
            sender: {
              type: "User",
            },
            comment: {
              body: "/command",
            },
          },
        } as unknown as GitHubContext,
        listenerPlugin,
        pullRequestCommentCreated
      )
    ).resolves.toBe(false);

    // Skipping comment that doesn't match a command and listener
    await expect(
      shouldSkipPlugin(
        {
          ...baseContext,
          key: pullRequestCommentCreated,
          payload: {
            sender: {
              type: "User",
            },
            comment: {
              body: "hello",
            },
          },
        } as unknown as GitHubContext,
        listenerPlugin,
        pullRequestCommentCreated
      )
    ).resolves.toBe(true);
  });
});
