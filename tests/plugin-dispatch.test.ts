import type { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { assertEquals } from "jsr:@std/assert";
import type { GitHubContext } from "../src/github/github-context.ts";
import type { GithubPlugin } from "../src/github/types/plugin-configuration.ts";

import { resolvePluginDispatchTarget } from "../src/github/utils/plugin-dispatch.ts";

const URL_EXAMPLE = "https://worker.example";
const WORKFLOW_ID = "action.yml";
const DEVELOPMENT_REF = "development";
const DIST_DEVELOPMENT_REF = "dist/development";
const MANIFEST_FIXTURE = {
  name: "plugin",
  short_name: "ubiquity-os-marketplace/daemon-spec-rewriter@development",
  homepage_url: "",
  description: "plugin fixture",
  "ubiquity:listeners": ["issue_comment.created"],
  commands: {},
};

function createNotFoundError() {
  const error = new Error("Not Found") as Error & { status: number };
  error.status = 404;
  return error;
}

Deno.test("resolvePluginDispatchTarget: prefers manifest worker urls for github plugin targets", async () => {
  let reposGetCalls = 0;

  const context = {
    octokit: {
      rest: {
        apps: {
          getRepoInstallation: async () => ({ data: { id: 123 } }),
        },
      },
    },
    eventHandler: {
      getAuthenticatedOctokit: () => ({
        rest: {
          repos: {
            get: async () => {
              reposGetCalls += 1;
              return { data: { default_branch: "main" } };
            },
          },
        },
      }),
    },
    logger: { debug: () => {} },
  } as unknown as GitHubContext;

  const plugin: GithubPlugin = { owner: "octo", repo: "demo", workflowId: WORKFLOW_ID };
  const manifest = { homepage_url: URL_EXAMPLE } as Manifest;

  const target = await resolvePluginDispatchTarget({ context, plugin, manifest });

  assertEquals(target, { kind: "worker", targetUrl: URL_EXAMPLE, ref: URL_EXAMPLE });
  assertEquals(reposGetCalls, 0);
});

Deno.test("resolvePluginDispatchTarget: falls back to workflow dispatch using the default branch", async () => {
  let appsGetRepoInstallationCalls = 0;
  let reposGetCalls = 0;

  const context = {
    octokit: {
      rest: {
        apps: {
          getRepoInstallation: async () => {
            appsGetRepoInstallationCalls += 1;
            return { data: { id: 123 } };
          },
        },
      },
    },
    eventHandler: {
      getAuthenticatedOctokit: () => ({
        rest: {
          repos: {
            get: async () => {
              reposGetCalls += 1;
              return { data: { default_branch: "main" } };
            },
          },
        },
      }),
    },
    logger: { debug: () => {} },
  } as unknown as GitHubContext;

  const plugin: GithubPlugin = { owner: "octo", repo: "demo", workflowId: WORKFLOW_ID };
  const manifest = { homepage_url: "" } as Manifest;

  const target = await resolvePluginDispatchTarget({ context, plugin, manifest });

  assertEquals(appsGetRepoInstallationCalls, 1);
  assertEquals(reposGetCalls, 1);
  assertEquals(target, { kind: "workflow", owner: "octo", repository: "demo", workflowId: WORKFLOW_ID, ref: "main" });
});

Deno.test("resolvePluginDispatchTarget: uses dist/development when artifact manifest exists", async () => {
  const refsTried: string[] = [];
  let reposGetCalls = 0;
  const context = {
    octokit: {
      rest: {
        repos: {
          getContent: async ({ ref }: { ref?: string }) => {
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
        },
      },
    },
    eventHandler: {
      getAuthenticatedOctokit: () => ({
        rest: {
          repos: {
            get: async () => {
              reposGetCalls += 1;
              return { data: { default_branch: "main" } };
            },
          },
        },
      }),
    },
    logger: {
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  } as unknown as GitHubContext;

  const plugin: GithubPlugin = { owner: "octo", repo: "demo", workflowId: WORKFLOW_ID, ref: DEVELOPMENT_REF };
  const target = await resolvePluginDispatchTarget({ context, plugin });

  assertEquals(target, { kind: "workflow", owner: "octo", repository: "demo", workflowId: WORKFLOW_ID, ref: DIST_DEVELOPMENT_REF });
  assertEquals(refsTried, [DIST_DEVELOPMENT_REF]);
  assertEquals(reposGetCalls, 0);
});

Deno.test("resolvePluginDispatchTarget: does not alias development to develop", async () => {
  const refsTried: string[] = [];
  let reposGetCalls = 0;
  const context = {
    octokit: {
      rest: {
        repos: {
          getContent: async ({ ref }: { ref?: string }) => {
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
        },
      },
    },
    eventHandler: {
      getAuthenticatedOctokit: () => ({
        rest: {
          repos: {
            get: async () => {
              reposGetCalls += 1;
              return { data: { default_branch: "main" } };
            },
          },
        },
      }),
    },
    logger: {
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  } as unknown as GitHubContext;

  const plugin: GithubPlugin = { owner: "octo", repo: "demo", workflowId: WORKFLOW_ID, ref: DEVELOPMENT_REF };
  const target = await resolvePluginDispatchTarget({ context, plugin });

  assertEquals(target, { kind: "workflow", owner: "octo", repository: "demo", workflowId: WORKFLOW_ID, ref: DEVELOPMENT_REF });
  assertEquals(refsTried, [DIST_DEVELOPMENT_REF, DEVELOPMENT_REF]);
  assertEquals(reposGetCalls, 0);
});

Deno.test("resolvePluginDispatchTarget: falls back to source branch when artifact manifests are absent", async () => {
  const refsTried: string[] = [];
  let reposGetCalls = 0;
  const context = {
    octokit: {
      rest: {
        repos: {
          getContent: async ({ ref }: { ref?: string }) => {
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
        },
      },
    },
    eventHandler: {
      getAuthenticatedOctokit: () => ({
        rest: {
          repos: {
            get: async () => {
              reposGetCalls += 1;
              return { data: { default_branch: "main" } };
            },
          },
        },
      }),
    },
    logger: {
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  } as unknown as GitHubContext;

  const plugin: GithubPlugin = { owner: "octo", repo: "demo", workflowId: WORKFLOW_ID, ref: DEVELOPMENT_REF };
  const target = await resolvePluginDispatchTarget({ context, plugin });

  assertEquals(target, { kind: "workflow", owner: "octo", repository: "demo", workflowId: WORKFLOW_ID, ref: DEVELOPMENT_REF });
  assertEquals(refsTried, [DIST_DEVELOPMENT_REF, DEVELOPMENT_REF]);
  assertEquals(reposGetCalls, 0);
});
