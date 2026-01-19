import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import type { GitHubContext } from "../src/github/github-context.ts";
import type { GithubPlugin } from "../src/github/types/plugin-configuration.ts";

const WORKFLOW_DISPATCH_MODULE = "../src/github/utils/workflow-dispatch";
const PLUGIN_DISPATCH_MODULE = "../src/github/utils/plugin-dispatch";
const URL_EXAMPLE = "https://worker.example";
const WORKFLOW_ID = "action.yml";

jest.mock(WORKFLOW_DISPATCH_MODULE, () => ({
  ...(jest.requireActual(WORKFLOW_DISPATCH_MODULE) as object),
  getDefaultBranch: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe("resolvePluginDispatchTarget", () => {
  it("prefers manifest worker urls for github plugin targets", async () => {
    const { resolvePluginDispatchTarget } = await import(PLUGIN_DISPATCH_MODULE);
    const { getDefaultBranch } = await import(WORKFLOW_DISPATCH_MODULE);
    const getDefaultBranchMock = getDefaultBranch as jest.Mock;
    const context = {} as GitHubContext;
    const plugin: GithubPlugin = { owner: "octo", repo: "demo", workflowId: WORKFLOW_ID };
    const manifest = { homepage_url: URL_EXAMPLE } as Manifest;

    const target = await resolvePluginDispatchTarget({ context, plugin, manifest });

    expect(target).toEqual({
      kind: "worker",
      targetUrl: URL_EXAMPLE,
      ref: URL_EXAMPLE,
    });
    expect(getDefaultBranchMock).not.toHaveBeenCalled();
  });

  it("falls back to workflow dispatch using the default branch", async () => {
    const { resolvePluginDispatchTarget } = await import(PLUGIN_DISPATCH_MODULE);
    const { getDefaultBranch } = await import(WORKFLOW_DISPATCH_MODULE);
    const getDefaultBranchMock = getDefaultBranch as jest.Mock<() => Promise<string>>;
    const context = {} as GitHubContext;
    const plugin: GithubPlugin = { owner: "octo", repo: "demo", workflowId: WORKFLOW_ID };
    const manifest = { homepage_url: "" } as Manifest;

    getDefaultBranchMock.mockResolvedValueOnce("main");
    const target = await resolvePluginDispatchTarget({ context, plugin, manifest });

    expect(getDefaultBranchMock).toHaveBeenCalledWith(context, "octo", "demo");
    expect(target).toEqual({
      kind: "workflow",
      owner: "octo",
      repository: "demo",
      workflowId: "action.yml",
      ref: "main",
    });
  });
});
