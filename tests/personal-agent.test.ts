import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { drop } from "@mswjs/data";
import { customOctokit as Octokit } from "@ubiquity-os/plugin-sdk/octokit";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { logger } from "../src/logger/logger";
import { db } from "./__mocks__/db";
import { server } from "./__mocks__/node";
import { createConfigurationHandler } from "./test-utils/configuration-handler";

const createWorkflowDispatch = jest.fn(() => ({}));

jest.mock("../src/github/handlers/router-decision", () => ({
  getRouterDecision: jest.fn(),
}));
jest.mock("../src/github/utils/comment-dedupe", () => ({
  shouldSkipDuplicateCommentEvent: jest.fn().mockResolvedValue(false),
}));
jest.mock("../src/github/github-client", () => ({
  tokenOctokit: jest.fn().mockImplementation(() => ({
    rest: {
      repos: {
        get: jest.fn().mockResolvedValue({ data: { default_branch: "main" } }),
      },
      actions: {
        createWorkflowDispatch: createWorkflowDispatch,
      },
    },
  })),
}));
const commentCreateEvent = "issue_comment.created";
let nextCommentId = 1000;

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
  jest.clearAllMocks();
  jest.resetModules();
});
afterAll(() => server.close());

describe("Personal Agent tests", () => {
  beforeEach(async () => {
    nextCommentId = 1000;
    drop(db);
  });

  it("Should dispatch personal agent when tagged", async () => {
    const { getRouterDecision } = await import("../src/github/handlers/router-decision");
    (getRouterDecision as jest.Mock).mockResolvedValue({
      raw: JSON.stringify({ action: "ignore" }),
      decision: { action: "ignore" },
    });

    const issueCommentCreated = (await import("../src/github/handlers/issue-comment-created")).default;
    const { context, errorSpy, infoSpy } = createContext("@test_acc2 help");

    expect(context.key).toBe(commentCreateEvent);

    await issueCommentCreated(context);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(getRouterDecision).not.toHaveBeenCalled();
    expect(createWorkflowDispatch).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(expect.any(Object), "Dispatching personal-agent workflow");
  });

  it("Should dispatch only for the leading mention", async () => {
    const issueCommentCreated = (await import("../src/github/handlers/issue-comment-created")).default;
    const { context, errorSpy } = createContext("@test_acc2 please review with @test_acc3");

    expect(context.key).toBe(commentCreateEvent);

    await issueCommentCreated(context);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(createWorkflowDispatch).toHaveBeenCalledTimes(1);
  });

  it("Should not dispatch when mention is not leading", async () => {
    const issueCommentCreated = (await import("../src/github/handlers/issue-comment-created")).default;
    const { context, errorSpy } = createContext("Please review with @test_acc2");

    expect(context.key).toBe(commentCreateEvent);

    await issueCommentCreated(context);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });
});

function createContext(commentBody: string) {
  const context = createContextInner(commentBody);
  const infoSpy = jest.spyOn(context.logger, "info");
  const errorSpy = jest.spyOn(context.logger, "error");
  const debugSpy = jest.spyOn(context.logger, "debug");

  return {
    context,
    infoSpy,
    errorSpy,
    debugSpy,
  };
}

function createContextInner(commentBody: string): GitHubContext<"issue_comment.created"> {
  const octokit = {
    rest: {
      actions: {
        createWorkflowDispatch: createWorkflowDispatch,
      },
      apps: {
        getRepoInstallation: () => ({
          data: { id: 123456 },
        }),
        listInstallations: () => ({ data: [{ id: 123456, account: { login: "test_acc2" } }] }),
      },
      repos: {
        get: () => ({
          data: { default_branch: "main" },
        }),
        getCollaboratorPermissionLevel: jest.fn(() => ({
          data: { role_name: "admin" },
        })),
      },
    },
  };
  return {
    id: "",
    key: commentCreateEvent,
    name: commentCreateEvent,
    payload: {
      action: "created",
      repository: { owner: { login: "test_acc" }, name: "ubiquity-os-kernel" },
      installation: { id: 123456 },
      comment: {
        id: nextCommentId++,
        body: commentBody,
        user: {
          login: "test_acc",
          type: "User",
        },
      },
      issue: { user: { login: "test_acc2" }, number: 1 },
    } as GitHubContext<"issue_comment.created">["payload"],
    logger: logger,
    octokit: octokit as unknown as InstanceType<typeof Octokit>,
    eventHandler: {
      environment: "production",
      getToken: jest.fn().mockReturnValue("1234"),
      signPayload: jest.fn().mockReturnValue("sha256=1234"),
      getAuthenticatedOctokit: jest.fn().mockReturnValue(octokit),
      getUnauthenticatedOctokit: jest.fn().mockReturnValue(octokit),
      logger: logger,
    } as unknown as GitHubEventHandler,
    llm: "",
    configurationHandler: createConfigurationHandler() as unknown as GitHubContext<"issue_comment.created">["configurationHandler"],
  };
}
