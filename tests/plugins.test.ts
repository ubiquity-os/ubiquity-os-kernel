import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { GitHubContext } from "../src/github/github-context";
import { shouldSkipPlugin } from "../src/github/utils/plugins";
import { PluginConfiguration } from "../src/github/types/plugin-configuration";
import { server } from "./__mocks__/node";
import { http, HttpResponse } from "msw";

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
    server.use(
      http.get("http://localhost/manifest.json", () => {
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
    const pluginChain = {
      uses: [{ skipBotEvents: true, plugin: pluginAddress }],
    } as PluginConfiguration["plugins"][0];
    // Skip bot comment
    await expect(
      shouldSkipPlugin(
        {
          payload: {
            sender: {
              type: "Bot",
            },
          },
        } as unknown as GitHubContext,
        pluginChain,
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
        } as unknown as GitHubContext,
        pluginChain,
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
        } as unknown as GitHubContext,
        pluginChain,
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
        } as unknown as GitHubContext,
        {
          uses: [{ skipBotEvents: true, runsOn: [pullRequestOpened], plugin: pluginAddress }],
        } as PluginConfiguration["plugins"][0],
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
        } as unknown as GitHubContext,
        {
          uses: [{ skipBotEvents: true, runsOn: [pullRequestOpened], plugin: pluginAddress }],
        } as PluginConfiguration["plugins"][0],
        "pull_request.closed"
      )
    ).resolves.toBe(true);
  });
});
