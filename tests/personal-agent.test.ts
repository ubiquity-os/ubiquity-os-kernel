import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { drop } from "@mswjs/data";
import { customOctokit as Octokit } from "@ubiquity-os/plugin-sdk/octokit";
import { db } from "./__mocks__/db";
import { server } from "./__mocks__/node";
import { GitHubContext } from "../src/github/github-context";
import { logger } from "../src/logger/logger";
import { GitHubEventHandler } from "../src/github/github-event-handler";

const createWorkflowDispatch = jest.fn(() => ({}));
const commentCreateEvent = "issue_comment.created";

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
  jest.clearAllMocks();
});
afterAll(() => server.close());

describe("Personal Agent tests", () => {
  beforeEach(async () => {
    drop(db);
  });

  it("Should handle personal agent command", async () => {
    const issueCommentCreated = (await import("../src/github/handlers/issue-comment-created")).default;
    const { context, errorSpy, infoSpy, debugSpy } = createContext("@test_acc2 help");

    expect(context.key).toBe(commentCreateEvent);

    await issueCommentCreated(context);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenNthCalledWith(
      1,
      {
        personalAgentOwner: "test_acc2",
        owner: "test_acc",
        comment: "@test_acc2 help",
      },
      `Comment received`
    );
    expect(infoSpy).toHaveBeenNthCalledWith(1, `Successfully sent the comment to test_acc2/personal-agent`);
    expect(createWorkflowDispatch).toHaveBeenCalledTimes(1);
  });

  it("Should ignore irrelevant comments", async () => {
    const issueCommentCreated = (await import("../src/github/handlers/issue-comment-created")).default;
    const { context, errorSpy, debugSpy } = createContext("foo bar");

    expect(context.key).toBe(commentCreateEvent);
    expect(context.payload.comment.body).toBe("foo bar");

    await issueCommentCreated(context);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenNthCalledWith(1, "Ignoring irrelevant comment: foo bar");
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
      },
    },
  };
  return {
    id: "",
    key: commentCreateEvent,
    name: commentCreateEvent,
    payload: {
      action: "created",
      repository: { owner: { login: "test_acc" } },
      comment: { body: commentBody },
    } as GitHubContext<"issue_comment.created">["payload"],
    logger: logger,
    octokit: octokit as unknown as InstanceType<typeof Octokit>,
    eventHandler: {
      environment: "production",
      getToken: jest.fn().mockReturnValue("1234"),
      signPayload: jest.fn().mockReturnValue("sha256=1234"),
      getAuthenticatedOctokit: jest.fn().mockReturnValue(octokit),
      logger: logger,
    } as unknown as GitHubEventHandler,
    openAi: {} as unknown as GitHubContext<"issue_comment.created">["openAi"],
    llm: "",
  };
}
