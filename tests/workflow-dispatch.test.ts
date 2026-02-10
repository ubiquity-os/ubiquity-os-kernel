import { assertEquals } from "jsr:@std/assert";

import { dispatchWorkflow } from "../src/github/utils/workflow-dispatch.ts";

const COMMAND_HELLO = "command-hello";
const MARKETPLACE = "ubiquity-os-marketplace";

Deno.test("dispatchWorkflow: dispatches provided workflow id", async () => {
  const getRepoInstallationCalls: Array<{ owner: string; repo: string }> = [];
  const createWorkflowDispatchCalls: Array<{ owner: string; repo: string; workflow_id: string; ref: string; inputs: Record<string, string> }> = [];

  async function getRepoInstallation({ owner, repo }: { owner: string; repo: string }) {
    getRepoInstallationCalls.push({ owner, repo });
    return { data: { id: 123 } };
  }

  async function getRepo() {
    return { data: { default_branch: "main" } };
  }

  async function createWorkflowDispatch(args: { owner: string; repo: string; workflow_id: string; ref: string; inputs: Record<string, string> }) {
    createWorkflowDispatchCalls.push(args);
    return { ok: true };
  }

  const context = {
    octokit: {
      rest: {
        apps: { getRepoInstallation },
      },
    },
    eventHandler: {
      getUnauthenticatedOctokit: () => ({
        rest: {
          apps: { getRepoInstallation },
        },
      }),
      getAuthenticatedOctokit: () => ({
        rest: {
          actions: {
            createWorkflowDispatch,
          },
          repos: {
            get: getRepo,
          },
        },
      }),
    },
    logger: {
      debug: () => {},
    },
  } as never;

  await dispatchWorkflow(context, {
    owner: MARKETPLACE,
    repository: COMMAND_HELLO,
    workflowId: "legacy.yml",
    ref: "fix/action-entry",
    inputs: { foo: "bar" },
  });

  assertEquals(getRepoInstallationCalls, [{ owner: MARKETPLACE, repo: COMMAND_HELLO }]);
  assertEquals(createWorkflowDispatchCalls.length, 1);
  assertEquals(createWorkflowDispatchCalls[0], {
    owner: MARKETPLACE,
    repo: COMMAND_HELLO,
    workflow_id: "legacy.yml",
    ref: "fix/action-entry",
    inputs: { foo: "bar" },
  });
});
