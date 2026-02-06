import { EmitterWebhookEventName } from "@octokit/webhooks";
import { assertEquals } from "jsr:@std/assert";
import { GitHubContext } from "../src/github/github-context.ts";
import { ResolvedPlugin, shouldSkipPlugin } from "../src/github/utils/plugins.ts";
import { logger } from "../src/logger/logger.ts";

Deno.test("Plugin tests: should skip plugins if needed", async () => {
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
  assertEquals(
    await shouldSkipPlugin(
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
    ),
    true
  );

  // Skipping because the plugin doesn't listen to the event
  assertEquals(
    await shouldSkipPlugin(
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
    ),
    true
  );

  // Not skipping when runsOn matches the event
  assertEquals(
    await shouldSkipPlugin(
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
    ),
    false
  );

  // Not skipping matching listener
  assertEquals(
    await shouldSkipPlugin(
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
    ),
    false
  );

  // Skipping non-matching listener
  assertEquals(
    await shouldSkipPlugin(
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
    ),
    true
  );
});
