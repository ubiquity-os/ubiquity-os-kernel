import { EmitterWebhookEventName } from "@octokit/webhooks";
import { assertEquals } from "jsr:@std/assert";
import { GitHubContext } from "../src/github/github-context.ts";
import { getManifest, ResolvedPlugin, shouldSkipPlugin } from "../src/github/utils/plugins.ts";

const testLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  github: () => {},
};

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
        logger: testLogger,
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
        logger: testLogger,
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
        logger: testLogger,
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
        logger: testLogger,
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
        logger: testLogger,
      } as unknown as GitHubContext,
      pluginWithRunsOn([pullRequestOpened]),
      "pull_request.closed"
    ),
    true
  );
});

const MANIFEST_FIXTURE = {
  name: "plugin",
  short_name: "ubiquity-os-marketplace/command-query@development",
  homepage_url: "",
  description: "plugin fixture",
  "ubiquity:listeners": ["issue_comment.created"],
  commands: {},
};
const NOT_FOUND_ERROR = "Not Found";
const DIST_DEVELOPMENT_REF = "dist/development";
const DIST_DEVELOP_REF = "dist/develop";
const DEVELOPMENT_REF = "development";
const PLUGIN_TARGET = {
  owner: "ubiquity-os-marketplace",
  repo: "command-query",
  workflowId: "compute.yml",
  ref: DEVELOPMENT_REF,
} as const;

function createNotFoundError() {
  const error = new Error(NOT_FOUND_ERROR) as Error & { status: number };
  error.status = 404;
  return error;
}

function createManifestContext(getContent: (args: { ref?: string }) => Promise<{ data: { content: string } }>): GitHubContext {
  return {
    octokit: {
      rest: {
        repos: {
          getContent,
        },
      },
    },
    eventHandler: {
      environment: "development",
    },
    logger: testLogger,
  } as unknown as GitHubContext;
}

Deno.test("getManifest: prefers dist/<ref> for GitHub plugins", async () => {
  const refsTried: string[] = [];
  const context = createManifestContext(async ({ ref }) => {
    refsTried.push(String(ref));
    if (ref === DIST_DEVELOPMENT_REF) {
      return {
        data: {
          content: btoa(JSON.stringify(MANIFEST_FIXTURE)),
        },
      };
    }
    throw createNotFoundError();
  });

  const manifest = await getManifest(context, { ...PLUGIN_TARGET });

  assertEquals(manifest?.short_name, MANIFEST_FIXTURE.short_name);
  assertEquals(refsTried, [DIST_DEVELOPMENT_REF]);
});

Deno.test("getManifest: resolves development refs through dist/develop compatibility alias", async () => {
  const refsTried: string[] = [];
  const context = createManifestContext(async ({ ref }) => {
    refsTried.push(String(ref));
    if (ref === DIST_DEVELOP_REF) {
      return {
        data: {
          content: btoa(JSON.stringify(MANIFEST_FIXTURE)),
        },
      };
    }
    throw createNotFoundError();
  });

  const manifest = await getManifest(context, { ...PLUGIN_TARGET });

  assertEquals(manifest?.short_name, MANIFEST_FIXTURE.short_name);
  assertEquals(refsTried, [DIST_DEVELOPMENT_REF, DIST_DEVELOP_REF]);
});

Deno.test("getManifest: falls back to source branch ref when dist refs are absent", async () => {
  const refsTried: string[] = [];
  const context = createManifestContext(async ({ ref }) => {
    refsTried.push(String(ref));
    if (ref === DEVELOPMENT_REF) {
      return {
        data: {
          content: btoa(JSON.stringify(MANIFEST_FIXTURE)),
        },
      };
    }
    throw createNotFoundError();
  });

  const manifest = await getManifest(context, { ...PLUGIN_TARGET });

  assertEquals(manifest?.short_name, MANIFEST_FIXTURE.short_name);
  assertEquals(refsTried, [DIST_DEVELOPMENT_REF, DIST_DEVELOP_REF, DEVELOPMENT_REF]);
});
