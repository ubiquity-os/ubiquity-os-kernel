import { assertEquals, assertStringIncludes } from "jsr:@std/assert";

import type { GitHubContext } from "../src/github/github-context.ts";
import issueCommentCreated from "../src/github/handlers/issue-comment-created.ts";
import { CONFIG_FULL_PATH } from "../src/github/utils/config.ts";
import { stubFetch } from "./test-utils/fetch-stub.ts";

const ISSUE_COMMENT_CREATED = "issue_comment.created";
let nextCommentId = 1000;

function createLogger() {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    github: () => {},
  };
}

function createAuthenticatedOctokit(workflowDispatchCalls: unknown[]) {
  return {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
      },
      actions: {
        createWorkflowDispatch: async (args: unknown) => {
          workflowDispatchCalls.push(args);
          return {};
        },
        listWorkflowRuns: async () => ({
          data: {
            workflow_runs: [
              {
                html_url: "https://github.com/ubiquity-os/ubiquity-os-kernel/actions/runs/1",
                created_at: new Date().toISOString(),
                event: "workflow_dispatch",
                head_branch: "main",
              },
            ],
          },
        }),
      },
    },
  };
}

function createBaseContext(
  body: string,
  authorType: "User" | "Bot",
  options?: {
    commentId?: number;
    octokit?: Record<string, unknown>;
    eventHandler?: Record<string, unknown>;
  }
): GitHubContext<"issue_comment.created"> {
  const workflowDispatchCalls: unknown[] = [];
  const logger = createLogger();
  const authorLogin = authorType === "User" ? "test-user" : "ubiquity-os-beta[bot]";
  const commentId = options?.commentId ?? nextCommentId++;
  const authenticatedOctokit = createAuthenticatedOctokit(workflowDispatchCalls);
  const octokitOverrides = options?.octokit ?? {};
  const overriddenRest = (octokitOverrides.rest ?? {}) as Record<string, unknown>;
  const eventHandlerOverrides = options?.eventHandler ?? {};
  const overriddenAgent = (eventHandlerOverrides.agent ?? {}) as Record<string, unknown>;

  const octokit = {
    ...octokitOverrides,
    rest: {
      reactions: {
        createForIssueComment: async () => ({}),
        ...(overriddenRest.reactions as Record<string, unknown> | undefined),
      },
      issues: {
        createComment: async () => ({}),
        updateComment: async () => ({}),
        get: async () => ({ data: { body: "", body_html: "" } }),
        listComments: async () => ({ data: [] }),
        ...(overriddenRest.issues as Record<string, unknown> | undefined),
      },
      pulls: {
        updateReviewComment: async () => ({}),
        ...(overriddenRest.pulls as Record<string, unknown> | undefined),
      },
      apps: {
        getRepoInstallation: async () => ({ data: { id: 999 } }),
        ...(overriddenRest.apps as Record<string, unknown> | undefined),
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { role_name: "admin" },
        }),
        getContent: async () => ({ data: null }),
        ...(overriddenRest.repos as Record<string, unknown> | undefined),
      },
    },
    paginate: octokitOverrides.paginate ?? (async () => []),
  };

  const eventHandler = {
    environment: "production",
    logger,
    ...eventHandlerOverrides,
    getToken: eventHandlerOverrides.getToken ?? (async () => "ghs_test_token"),
    getAuthenticatedOctokit: eventHandlerOverrides.getAuthenticatedOctokit ?? (() => authenticatedOctokit),
    signPayload: eventHandlerOverrides.signPayload ?? (async () => "signature"),
    getKernelPublicKeyPem: eventHandlerOverrides.getKernelPublicKeyPem ?? (() => ""),
    kernelRefreshUrl: eventHandlerOverrides.kernelRefreshUrl ?? "",
    kernelRefreshIntervalSeconds: eventHandlerOverrides.kernelRefreshIntervalSeconds ?? 60,
    agent: {
      owner: "ubiquity-os",
      repo: "ubiquity-os-kernel",
      workflowId: "agent.yml",
      ref: "main",
      ...overriddenAgent,
    },
  };

  return {
    id: "",
    key: ISSUE_COMMENT_CREATED,
    name: ISSUE_COMMENT_CREATED,
    payload: {
      action: "created",
      installation: { id: 1 },
      sender: { login: authorLogin, type: authorType },
      comment: {
        id: commentId,
        node_id: `node-${commentId}`,
        body,
        html_url: `https://github.com/ubiquity-os/ubiquity-os-kernel/issues/331#issuecomment-${commentId}`,
        user: {
          login: authorLogin,
          type: authorType,
          id: authorType === "User" ? 1 : 2,
        },
        author_association: "MEMBER",
      },
      issue: {
        number: 331,
        node_id: "I_kwDOTest",
        title: "Test issue",
        html_url: "https://github.com/ubiquity-os/ubiquity-os-kernel/issues/331",
        created_at: new Date(0).toISOString(),
        user: { login: "issue-owner", id: 42 },
      },
      repository: {
        id: 123,
        name: "ubiquity-os-kernel",
        full_name: "ubiquity-os/ubiquity-os-kernel",
        owner: { login: "ubiquity-os", id: 456 },
      },
    } as GitHubContext<"issue_comment.created">["payload"],
    logger: logger as never,
    octokit: octokit as never,
    eventHandler: eventHandler as never,
    llm: "",
  };
}

Deno.test("issueCommentCreated: routes human /help to help output", async () => {
  const originalGitRevision = Deno.env.get("GIT_REVISION");
  Deno.env.set("GIT_REVISION", "deadbeef");

  const fetchStub = stubFetch({
    "https://plugin-a.internal/manifest.json": new Response(
      JSON.stringify({
        name: "plugin-a",
        short_name: "plugin-a",
        homepage_url: "",
        description: "plugin-a for tests",
        "ubiquity:listeners": [ISSUE_COMMENT_CREATED],
        commands: {
          foo: { description: "foo command", "ubiquity:example": "/foo bar" },
        },
      }),
      { headers: { "content-type": "application/json" } }
    ),
    "https://plugin-a.internal//manifest.json": new Response(
      JSON.stringify({
        name: "plugin-a",
        short_name: "plugin-a",
        homepage_url: "",
        description: "plugin-a for tests",
        "ubiquity:listeners": [ISSUE_COMMENT_CREATED],
        commands: {
          foo: { description: "foo command", "ubiquity:example": "/foo bar" },
        },
      }),
      { headers: { "content-type": "application/json" } }
    ),
  });

  const createCommentCalls: Array<{ body: string }> = [];
  const context = createBaseContext("/help", "User", {
    octokit: {
      rest: {
        issues: {
          createComment: async ({ body }: { body: string }) => {
            createCommentCalls.push({ body });
            return {};
          },
          updateComment: async () => ({}),
          get: async () => ({ data: { body: "", body_html: "" } }),
          listComments: async () => ({ data: [] }),
        },
        repos: {
          getCollaboratorPermissionLevel: async () => ({
            data: { role_name: "admin" },
          }),
          getContent: async ({ path }: { path: string }) => {
            if (path === CONFIG_FULL_PATH) {
              return {
                data: `
                plugins:
                  https://plugin-a.internal:
                    with: {}
                `,
              };
            }
            return { data: null };
          },
        },
      },
    },
  });

  try {
    await issueCommentCreated(context);
  } finally {
    fetchStub.restore();
    if (originalGitRevision === undefined) {
      Deno.env.delete("GIT_REVISION");
    } else {
      Deno.env.set("GIT_REVISION", originalGitRevision);
    }
  }

  assertEquals(createCommentCalls.length, 1);
  assertStringIncludes(createCommentCalls[0].body, "| `/help` | List all available commands. | `/help` |");
});

Deno.test("issueCommentCreated: ignores bot-authored /help comments", async () => {
  const createCommentCalls: unknown[] = [];
  const context = createBaseContext("/help", "Bot", {
    octokit: {
      rest: {
        issues: {
          createComment: async (args: unknown) => {
            createCommentCalls.push(args);
            return {};
          },
          updateComment: async () => ({}),
          get: async () => ({ data: { body: "", body_html: "" } }),
          listComments: async () => ({ data: [] }),
        },
      },
    },
  });

  await issueCommentCreated(context);

  assertEquals(createCommentCalls.length, 0);
});

Deno.test("issueCommentCreated: dispatches internal agent for explicit human mention", async () => {
  const workflowDispatchCalls: unknown[] = [];
  const reactionCalls: unknown[] = [];
  const context = createBaseContext("@ubiquityos agent implement the fix", "User", {
    octokit: {
      rest: {
        reactions: {
          createForIssueComment: async (args: unknown) => {
            reactionCalls.push(args);
            return {};
          },
        },
        issues: {
          createComment: async () => ({}),
          updateComment: async () => ({}),
          get: async () => ({ data: { body: "", body_html: "" } }),
          listComments: async () => ({ data: [] }),
        },
      },
    },
    eventHandler: {
      getAuthenticatedOctokit: () => createAuthenticatedOctokit(workflowDispatchCalls),
    },
  });

  await issueCommentCreated(context);

  assertEquals(reactionCalls.length, 1);
  assertEquals(workflowDispatchCalls.length, 1);
});

Deno.test("issueCommentCreated: ignores bot-authored agent mentions", async () => {
  const workflowDispatchCalls: unknown[] = [];
  const reactionCalls: unknown[] = [];
  const context = createBaseContext("@ubiquityos agent implement the fix", "Bot", {
    octokit: {
      rest: {
        reactions: {
          createForIssueComment: async (args: unknown) => {
            reactionCalls.push(args);
            return {};
          },
        },
      },
    },
    eventHandler: {
      getAuthenticatedOctokit: () => createAuthenticatedOctokit(workflowDispatchCalls),
    },
  });

  await issueCommentCreated(context);

  assertEquals(reactionCalls.length, 0);
  assertEquals(workflowDispatchCalls.length, 0);
});
