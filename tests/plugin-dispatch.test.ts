import type { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { assertEquals } from "jsr:@std/assert";
import type { GitHubContext } from "../src/github/github-context.ts";
import type { GithubPlugin } from "../src/github/types/plugin-configuration.ts";

import { resolvePluginDispatchTarget } from "../src/github/utils/plugin-dispatch.ts";

const URL_EXAMPLE = "https://worker.example";
const WORKFLOW_ID = "action.yml";

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

  assertEquals(target, { kind: "worker", targetUrl: URL_EXAMPLE, ref: URL_EXAMPLE, sourceRef: URL_EXAMPLE });
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
  assertEquals(target, {
    kind: "workflow",
    owner: "octo",
    repository: "demo",
    workflowId: WORKFLOW_ID,
    ref: "dist/main",
    sourceRef: "main",
  });
});
