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
const DEVELOPMENT_REF = "development";
const DIST_MAIN_REF = "dist/main";
const MAIN_REF = "main";
const PLUGIN_OWNER = "ubiquity-os-marketplace";
const PLUGIN_REPO = "command-query";
const PLUGIN_WORKFLOW_ID = "compute.yml";
const PLUGIN_TARGET = {
  owner: PLUGIN_OWNER,
  repo: PLUGIN_REPO,
  workflowId: PLUGIN_WORKFLOW_ID,
  ref: DEVELOPMENT_REF,
} as const;
const NO_REF_PLUGIN_TARGET = {
  owner: PLUGIN_OWNER,
  repo: PLUGIN_REPO,
  workflowId: PLUGIN_WORKFLOW_ID,
} as const;

function createNotFoundError() {
  const error = new Error(NOT_FOUND_ERROR) as Error & { status: number };
  error.status = 404;
  return error;
}

type ManifestContextOptions = {
  getContent: (args: { ref?: string }) => Promise<{ data: { content: string } }>;
  defaultBranch?: string;
  failDefaultBranchLookup?: boolean;
  onDefaultBranchLookup?: () => void;
};

function createManifestContext({
  getContent,
  defaultBranch = MAIN_REF,
  failDefaultBranchLookup = false,
  onDefaultBranchLookup,
}: ManifestContextOptions): GitHubContext {
  return {
    octokit: {
      rest: {
        apps: {
          getRepoInstallation: async () => ({ data: { id: 123 } }),
        },
        repos: {
          getContent,
        },
      },
    },
    eventHandler: {
      environment: "development",
      getAuthenticatedOctokit: () => ({
        rest: {
          repos: {
            get: async () => {
              onDefaultBranchLookup?.();
              if (failDefaultBranchLookup) {
                throw new Error("default branch lookup failed");
              }
              return { data: { default_branch: defaultBranch } };
            },
          },
        },
      }),
    },
    logger: testLogger,
  } as unknown as GitHubContext;
}

Deno.test("getManifest: prefers dist/<ref> for GitHub plugins", async () => {
  const refsTried: string[] = [];
  const context = createManifestContext({
    getContent: async ({ ref }) => {
      refsTried.push(String(ref));
      if (ref === DIST_DEVELOPMENT_REF) {
        return {
          data: {
            content: btoa(JSON.stringify(MANIFEST_FIXTURE)),
          },
        };
      }
      throw createNotFoundError();
    },
  });

  const manifest = await getManifest(context, { ...PLUGIN_TARGET });

  assertEquals(manifest?.short_name, MANIFEST_FIXTURE.short_name);
  assertEquals(refsTried, [DIST_DEVELOPMENT_REF]);
});

Deno.test("getManifest: does not alias development to develop", async () => {
  const refsTried: string[] = [];
  const context = createManifestContext({
    getContent: async ({ ref }) => {
      refsTried.push(String(ref));
      throw createNotFoundError();
    },
  });

  const manifest = await getManifest(context, { ...PLUGIN_TARGET });

  assertEquals(manifest, null);
  assertEquals(refsTried, [DIST_DEVELOPMENT_REF, DEVELOPMENT_REF]);
});

Deno.test("getManifest: falls back to source branch ref when dist refs are absent", async () => {
  const refsTried: string[] = [];
  const context = createManifestContext({
    getContent: async ({ ref }) => {
      refsTried.push(String(ref));
      if (ref === DEVELOPMENT_REF) {
        return {
          data: {
            content: btoa(JSON.stringify(MANIFEST_FIXTURE)),
          },
        };
      }
      throw createNotFoundError();
    },
  });

  const manifest = await getManifest(context, { ...PLUGIN_TARGET });

  assertEquals(manifest?.short_name, MANIFEST_FIXTURE.short_name);
  assertEquals(refsTried, [DIST_DEVELOPMENT_REF, DEVELOPMENT_REF]);
});

Deno.test("getManifest: no-ref plugins prefer dist/<default_branch>", async () => {
  const refsTried: (string | undefined)[] = [];
  let defaultBranchLookups = 0;
  const context = createManifestContext({
    getContent: async ({ ref }) => {
      refsTried.push(ref);
      if (ref === DIST_MAIN_REF) {
        return {
          data: {
            content: btoa(JSON.stringify(MANIFEST_FIXTURE)),
          },
        };
      }
      throw createNotFoundError();
    },
    defaultBranch: MAIN_REF,
    onDefaultBranchLookup: () => {
      defaultBranchLookups += 1;
    },
  });

  const manifest = await getManifest(context, { ...NO_REF_PLUGIN_TARGET });

  assertEquals(manifest?.short_name, MANIFEST_FIXTURE.short_name);
  assertEquals(defaultBranchLookups, 1);
  assertEquals(refsTried, [DIST_MAIN_REF]);
});

Deno.test("getManifest: no-ref plugins fall back to <default_branch> when dist refs are absent", async () => {
  const refsTried: (string | undefined)[] = [];
  let defaultBranchLookups = 0;
  const context = createManifestContext({
    getContent: async ({ ref }) => {
      refsTried.push(ref);
      if (ref === MAIN_REF) {
        return {
          data: {
            content: btoa(JSON.stringify(MANIFEST_FIXTURE)),
          },
        };
      }
      throw createNotFoundError();
    },
    defaultBranch: MAIN_REF,
    onDefaultBranchLookup: () => {
      defaultBranchLookups += 1;
    },
  });

  const manifest = await getManifest(context, { ...NO_REF_PLUGIN_TARGET });

  assertEquals(manifest?.short_name, MANIFEST_FIXTURE.short_name);
  assertEquals(defaultBranchLookups, 1);
  assertEquals(refsTried, [DIST_MAIN_REF, MAIN_REF]);
});

Deno.test("getManifest: no-ref plugins gracefully fall back to legacy lookup when default branch lookup fails", async () => {
  const refsTried: (string | undefined)[] = [];
  let defaultBranchLookups = 0;
  const context = createManifestContext({
    getContent: async ({ ref }) => {
      refsTried.push(ref);
      if (ref === undefined) {
        return {
          data: {
            content: btoa(JSON.stringify(MANIFEST_FIXTURE)),
          },
        };
      }
      throw createNotFoundError();
    },
    failDefaultBranchLookup: true,
    onDefaultBranchLookup: () => {
      defaultBranchLookups += 1;
    },
  });

  const manifest = await getManifest(context, { ...NO_REF_PLUGIN_TARGET });

  assertEquals(manifest?.short_name, MANIFEST_FIXTURE.short_name);
  assertEquals(defaultBranchLookups, 1);
  assertEquals(refsTried, [undefined]);
});
