import { assertEquals } from "jsr:@std/assert";

import { setRuntimeEnv } from "../src/github/utils/env.ts";
import { dispatchWorker, dispatchWorkflow } from "../src/github/utils/workflow-dispatch.ts";

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
        apps: {
          getRepoInstallation,
        },
      },
    },
    eventHandler: {
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

Deno.test("dispatchWorker: routes command-start-stop through the Cloudflare service binding", async () => {
  const requests: Request[] = [];
  const targetUrl = "https://ubiquity-os-command-start-stop-main.ubiquity.workers.dev";
  const serviceBinding = {
    fetch: async (request: Request) => {
      requests.push(request);
      return Response.json({ ok: true });
    },
  };

  setRuntimeEnv({ COMMAND_START_STOP: serviceBinding });
  try {
    const response = await dispatchWorker(targetUrl, { signature: "test-signature", stateId: "state-1" });
    assertEquals(response, { ok: true });
    assertEquals(requests.length, 1);
    assertEquals(requests[0].url, `${targetUrl}/`);
    assertEquals(requests[0].headers.get("x-hub-signature-256"), "sha256=test-signature");
  } finally {
    setRuntimeEnv({});
  }
});
