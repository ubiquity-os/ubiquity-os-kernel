import { describe, expect, it, jest } from "@jest/globals";
import { dispatchWorkflow } from "../src/github/utils/workflow-dispatch";

const MARKETPLACE = "ubiquity-os-marketplace";

describe("dispatchWorkflow", () => {
  it("should force action.yml workflow for fix/action-entry refs", async () => {
    const createWorkflowDispatch = jest.fn().mockResolvedValue({ ok: true });
    const listInstallations = jest.fn().mockResolvedValue({
      data: [{ id: 123, account: { login: MARKETPLACE } }],
    });

    const context = {
      octokit: {
        rest: {
          apps: {
            listInstallations,
          },
        },
      },
      eventHandler: {
        getAuthenticatedOctokit: jest.fn().mockReturnValue({
          rest: {
            actions: {
              createWorkflowDispatch,
            },
          },
        }),
      },
      logger: {
        debug: jest.fn(),
      },
    } as never;

    await dispatchWorkflow(context, {
      owner: MARKETPLACE,
      repository: "command-hello",
      workflowId: "legacy.yml",
      ref: "fix/action-entry",
      inputs: { foo: "bar" },
    });

    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: MARKETPLACE,
        repo: "command-hello",
        workflow_id: "action.yml",
        ref: "fix/action-entry",
        inputs: { foo: "bar" },
      })
    );
  });
});
