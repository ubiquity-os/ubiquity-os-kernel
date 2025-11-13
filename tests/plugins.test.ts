import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { EmitterWebhookEventName } from "@octokit/webhooks";
import { http, HttpResponse } from "msw";
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
    const pullRequestCommentCreated = "pull_request_review_comment.created";
    const pullRequestOpened = "pull_request.opened";
    const pluginManifestUrl = "http://localhost/manifest.json";
    server.use(
      http.get(pluginManifestUrl, () => {
        return HttpResponse.json({
          name: "command",
          commands: {
            command: {
              description: "command",
              "ubiquity:example": "/command",
            },
          },
        });
      })
    );
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

    // Skipping non-matching command
    await expect(
      shouldSkipPlugin(
        {
          key: issueCommentCreated,
          payload: {
            sender: {
              type: "User",
            },
            comment: {
              body: "/wrong-command",
            },
          },
          logger,
        } as unknown as GitHubContext,
        basePlugin,
        issueCommentCreated
      )
    ).resolves.toBe(true);

    // Not skipping matching command
    await expect(
      shouldSkipPlugin(
        {
          key: issueCommentCreated,
          payload: {
            sender: {
              type: "User",
            },
            comment: {
              body: "/command",
            },
          },
          logger,
        } as unknown as GitHubContext,
        basePlugin,
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

    // Not skipping matching listener + command
    server.use(
      http.get(
        pluginManifestUrl,
        () => {
          return HttpResponse.json({
            name: "command",
            "ubiquity:listeners": [issueCommentCreated],
            commands: {
              command: {
                description: "command",
                "ubiquity:example": "/command",
              },
            },
          });
        },
        { once: true }
      )
    );
    await expect(
      shouldSkipPlugin(
        {
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
        pluginWithRunsOn([issueCommentCreated]),
        pullRequestCommentCreated
      )
    ).resolves.toBe(false);

    // Skipping comment that doesn't match a command and listener
    server.use(
      http.get(
        pluginManifestUrl,
        () => {
          return HttpResponse.json({
            name: "command",
            "ubiquity:listeners": [issueCommentCreated],
            commands: {
              command: {
                description: "command",
                "ubiquity:example": "/command",
              },
            },
          });
        },
        { once: true }
      )
    );
    await expect(
      shouldSkipPlugin(
        {
          key: pullRequestCommentCreated,
          payload: {
            sender: {
              type: "User",
            },
            comment: {
              body: "hello",
            },
          },
          logger,
        } as unknown as GitHubContext,
        pluginWithRunsOn([issueCommentCreated]),
        pullRequestCommentCreated
      )
    ).resolves.toBe(true);
  });
});
