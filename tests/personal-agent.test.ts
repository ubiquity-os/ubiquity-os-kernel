import { assertEquals } from "jsr:@std/assert";

import type { GitHubContext } from "../src/github/github-context.ts";
import { callPersonalAgent } from "../src/github/handlers/personal-agent.ts";

type LogCall = { args: unknown[] };

function createLogger() {
  const calls = {
    debug: [] as LogCall[],
    info: [] as LogCall[],
    warn: [] as LogCall[],
    error: [] as LogCall[],
    github: [] as LogCall[],
  };
  const logger = {
    debug: (...args: unknown[]) => calls.debug.push({ args }),
    info: (...args: unknown[]) => calls.info.push({ args }),
    warn: (...args: unknown[]) => calls.warn.push({ args }),
    error: (...args: unknown[]) => calls.error.push({ args }),
    github: (...args: unknown[]) => calls.github.push({ args }),
  };
  return { logger, calls };
}

function createContext(commentBody: string): GitHubContext<"issue_comment.created"> {
  const { logger } = createLogger();
  return {
    id: "",
    key: "issue_comment.created",
    name: "issue_comment.created",
    payload: {
      action: "created",
      repository: { owner: { login: "test_acc" }, name: "ubiquity-os-kernel" },
      installation: { id: 123456 },
      comment: {
        id: 1001,
        body: commentBody,
        user: {
          login: "test_acc",
          type: "User",
        },
      },
      issue: { user: { login: "test_acc2" }, number: 1 },
    } as GitHubContext<"issue_comment.created">["payload"],
    logger: logger as never,
    octokit: {} as never,
    eventHandler: {
      environment: "production",
      logger: logger as never,
    } as never,
    llm: "",
  };
}

Deno.test("callPersonalAgent: dispatches workflow for @mention", async () => {
  const context = createContext("@test_acc2 help");

  const createWorkflowDispatchCalls: unknown[] = [];
  const updateRequestCommentRunUrlCalls: unknown[] = [];

  await callPersonalAgent(context, {
    getInstallationTokenForRepo: async () => "token_123",
    createTokenOctokit: () =>
      ({
        rest: {
          repos: {
            get: async () => ({ data: { default_branch: "main" } }),
          },
          actions: {
            createWorkflowDispatch: async (args: unknown) => {
              createWorkflowDispatchCalls.push(args);
              return {};
            },
          },
        },
      }) as never,
    buildWorkflowDispatchInputs: async () => ({ foo: "bar" }),
    updateRequestCommentRunUrl: async (...args) => {
      updateRequestCommentRunUrlCalls.push(args);
    },
  });

  assertEquals(createWorkflowDispatchCalls.length, 1);
  assertEquals(updateRequestCommentRunUrlCalls.length, 1);
});

Deno.test("callPersonalAgent: ignores irrelevant comments", async () => {
  const context = createContext("foo bar");

  const createWorkflowDispatchCalls: unknown[] = [];

  await callPersonalAgent(context, {
    getInstallationTokenForRepo: async () => "token_123",
    createTokenOctokit: () =>
      ({
        rest: {
          repos: {
            get: async () => ({ data: { default_branch: "main" } }),
          },
          actions: {
            createWorkflowDispatch: async (args: unknown) => {
              createWorkflowDispatchCalls.push(args);
              return {};
            },
          },
        },
      }) as never,
  });

  assertEquals(createWorkflowDispatchCalls.length, 0);
});
