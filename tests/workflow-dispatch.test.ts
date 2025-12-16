import { describe, expect, it, jest } from "@jest/globals";
import { dispatchWorkflow } from "../src/github/utils/workflow-dispatch";
const COMMAND_HELLO = "command-hello";
const MARKETPLACE = "ubiquity-os-marketplace";

describe("dispatchWorkflow", () => {
  it("should dispatch the provided workflow id", async () => {
    const createWorkflowDispatch = jest.fn().mockResolvedValue({ ok: true });
    const getRepoInstallation = jest.fn().mockResolvedValue({ data: { id: 123 } });

    const context = {
      octokit: {
        rest: {
          apps: {
            getRepoInstallation,
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
      repository: COMMAND_HELLO,
      workflowId: "legacy.yml",
      ref: "fix/action-entry",
      inputs: { foo: "bar" },
    });

    expect(getRepoInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: MARKETPLACE,
        repo: COMMAND_HELLO,
      })
    );
    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: MARKETPLACE,
        repo: COMMAND_HELLO,
        workflow_id: "legacy.yml",
        ref: "fix/action-entry",
        inputs: { foo: "bar" },
      })
    );
  });
});
