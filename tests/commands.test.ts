import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { config } from "dotenv";
import { http, HttpResponse } from "msw";
import type OpenAI from "openai";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { CONFIG_FULL_PATH } from "../src/github/utils/config";
import { logger } from "../src/logger/logger";
import { server } from "./__mocks__/node";
import "./__mocks__/webhooks";

jest.mock("@octokit/plugin-paginate-rest", () => ({}));
jest.mock("@octokit/plugin-rest-endpoint-methods", () => ({}));
jest.mock("@octokit/plugin-retry", () => ({}));
jest.mock("@octokit/plugin-throttling", () => ({}));
jest.mock("@octokit/auth-app", () => ({}));
jest.mock("../src/github/utils/workflow-dispatch", () => ({
  getDefaultBranch: jest.fn().mockResolvedValue("main"),
  dispatchWorkflow: jest.fn(),
  dispatchWorker: jest.fn(),
}));

config({ path: ".dev.vars" });

const kernelRepo = "ubiquity-os-kernel";
const name = kernelRepo;
const eventName = "issue_comment.created";
const UBIQUITY_OS_OWNER = "ubiquity-os";
const openAi = {} as unknown as OpenAI;
const baseComment = {
  user: {
    login: "test-user",
    type: "User",
  },
};

let nextCommentId = 1000;
const makeComment = (body: string) => ({
  ...baseComment,
  id: nextCommentId++,
  body,
});

type LlmRequestPayload = {
  messages?: Array<{ role?: string; content?: unknown }>;
};

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
  jest.clearAllMocks();
  jest.resetAllMocks();
  jest.resetModules();
});
afterAll(() => {
  server.close();
});

const eventHandler = {
  environment: "production",
  getToken: jest.fn().mockReturnValue("1234"),
  signPayload: jest.fn().mockReturnValue("sha256=1234"),
  aiBaseUrl: "https://ai-ubq-fi.deno.dev",
  getKernelPublicKeyPem: jest.fn().mockResolvedValue("test-kernel-key"),
  kernelRefreshUrl: "",
  agent: {
    owner: "ubiquity-os",
    repo: kernelRepo,
    workflowId: "agent.yml",
  },
  logger: logger,
} as unknown as GitHubEventHandler;

function getContent(params?: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
  if (params?.path === CONFIG_FULL_PATH) {
    return {
      data: `
      plugins:
        https://plugin-a.internal: {}
        ubiquity-os/plugin-b: {}
      `,
    };
  } else if (params?.path === "manifest.json") {
    return {
      data: {
        content: btoa(
          JSON.stringify({
            name: "plugin-B",
            short_name: "plugin-b",
            "ubiquity:listeners": [eventName],
            commands: {
              hello: {
                description: "This command says hello to the username provided in the parameters.",
                "ubiquity:example": "/hello @pavlovcik",
                parameters: {
                  type: "object",
                  properties: {
                    username: {
                      type: "string",
                      description: "the user to say hello to",
                    },
                  },
                },
              },
            },
          })
        ),
      },
    };
  } else {
    throw new Error("Not found");
  }
}

const payload = {
  repository: {
    owner: { login: "ubiquity" },
    name,
  },
  issue: { number: 1 },
  installation: {
    id: 1,
  },
};

describe("Event related tests", () => {
  beforeEach(() => {
    (eventHandler.getToken as unknown as jest.Mock).mockReturnValue("1234");
    (eventHandler.signPayload as unknown as jest.Mock).mockReturnValue("sha256=1234");
    server.use(
      http.get("https://plugin-a.internal/manifest.json", () =>
        HttpResponse.json({
          name: "plugin-A",
          short_name: "plugin-a",
          "ubiquity:listeners": [eventName],
          commands: {
            foo: {
              description: "foo command",
              "ubiquity:example": "/foo bar",
            },
            bar: {
              description: "bar command",
              "ubiquity:example": "/bar foo",
            },
          },
        })
      )
    );

    server.use(
      http.post("https://ai-ubq-fi.deno.dev/v1/chat/completions", async ({ request }) => {
        const body = (await request.json()) as LlmRequestPayload;
        const userContent = body.messages?.find((m) => m?.role === "user")?.content;
        let comment = "";
        try {
          const parsed = typeof userContent === "string" ? JSON.parse(userContent) : null;
          comment = typeof parsed?.comment === "string" ? parsed.comment : "";
        } catch {
          comment = "";
        }

        const normalized = comment.toLowerCase();
        let content: string;
        if (normalized.includes("available commands")) {
          content = JSON.stringify({ action: "help" });
        } else if (normalized.includes("say hello")) {
          content = JSON.stringify({ action: "command", command: { name: "hello", parameters: { username: "pavlovcik" } } });
        } else if (normalized.includes("rewrite spec")) {
          content = JSON.stringify({ action: "agent" });
        } else if (normalized.includes("creator of the universe")) {
          content = JSON.stringify({ action: "reply", reply: "Sorry, but I can't help with that." });
        } else {
          content = JSON.stringify({ action: "ignore" });
        }

        return HttpResponse.json({
          choices: [
            {
              message: {
                content,
              },
            },
          ],
        });
      })
    );
  });

  it("Should post the help menu", async () => {
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const spy = jest.spyOn(issues, "createComment");

    const issueCommentCreated = (await import("../src/github/handlers/issue-comment-created")).default;
    await issueCommentCreated({
      id: "",
      key: eventName,
      octokit: {
        rest: {
          issues,
          repos: {
            getContent: jest.fn(getContent),
          },
        },
      },
      openAi,
      eventHandler: eventHandler,
      payload: {
        ...payload,
        comment: makeComment("@UbiquityOS can you tell me all available commands"),
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
      logger: logger,
    } as unknown as GitHubContext);
    expect(spy).toBeCalledTimes(1);
    expect(spy.mock.calls).toEqual([
      [
        {
          body: "| Command | Description | Example |\n|---|---|---|\n| `/help` | List all available commands. | `/help` |\n| `/bar` | bar command | `/bar foo` |\n| `/foo` | foo command | `/foo bar` |\n| `/hello` | This command says hello to the username provided in the parameters. | `/hello @pavlovcik` |\n\n###### UbiquityOS Production [v7.0.0](https://github.com/ubiquity-os/ubiquity-os-kernel/releases/tag/v7.0.0) [159ea6e](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/159ea6e)",
          issue_number: 1,
          owner: "ubiquity",
          repo: name,
        },
      ],
    ]);
  });

  it("Should call appropriate plugin", async () => {
    const { dispatchWorkflow } = await import("../src/github/utils/workflow-dispatch");

    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const spy = jest.spyOn(issues, "createComment");

    const issueCommentCreated = (await import("../src/github/handlers/issue-comment-created")).default;
    await issueCommentCreated({
      id: "",
      key: eventName,
      octokit: {
        rest: {
          issues,
          repos: {
            getContent: jest.fn(getContent),
          },
        },
      },
      openAi,
      eventHandler: eventHandler,
      payload: {
        ...payload,
        comment: makeComment("@UbiquityOS can you say hello to @pavlovcik"),
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
      logger,
    } as unknown as GitHubContext);
    expect(spy).toBeCalledTimes(0);
    expect((dispatchWorkflow as jest.Mock).mock.calls.length).toEqual(1);
    expect((dispatchWorkflow as jest.Mock).mock.calls[0][1]).toMatchObject({
      owner: UBIQUITY_OS_OWNER,
      repository: "plugin-b",
      ref: "main",
      workflowId: "compute.yml",
      inputs: {
        command: JSON.stringify({ name: "hello", parameters: { username: "pavlovcik" } }),
      },
    });
  });

  it("Should route when @ubiquityos is mentioned mid-comment", async () => {
    const { dispatchWorkflow } = await import("../src/github/utils/workflow-dispatch");

    const issueCommentCreated = (await import("../src/github/handlers/issue-comment-created")).default;
    await issueCommentCreated({
      id: "",
      key: eventName,
      octokit: {
        rest: {
          issues: {
            createComment() {
              return;
            },
          },
          repos: {
            getContent: jest.fn(getContent),
          },
        },
      },
      openAi,
      eventHandler: eventHandler,
      payload: {
        ...payload,
        comment: makeComment("Hey @UbiquityOS can you say hello to @pavlovcik"),
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
      logger,
    } as unknown as GitHubContext);

    expect((dispatchWorkflow as jest.Mock).mock.calls.length).toEqual(1);
    expect((dispatchWorkflow as jest.Mock).mock.calls[0][1]).toMatchObject({
      owner: UBIQUITY_OS_OWNER,
      repository: "plugin-b",
      workflowId: "compute.yml",
    });
  });

  it("Should dispatch the agent workflow for complex requests", async () => {
    const { dispatchWorkflow } = await import("../src/github/utils/workflow-dispatch");

    const issueCommentCreated = (await import("../src/github/handlers/issue-comment-created")).default;
    await issueCommentCreated({
      id: "",
      key: eventName,
      octokit: {
        rest: {
          issues: {
            createComment() {
              return;
            },
          },
          repos: {
            getContent: jest.fn(getContent),
          },
        },
      },
      openAi,
      eventHandler: eventHandler,
      payload: {
        ...payload,
        comment: makeComment("Hey @UbiquityOS rewrite spec based on the thread and set the best time label"),
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
      logger,
    } as unknown as GitHubContext);

    expect((dispatchWorkflow as jest.Mock).mock.calls.length).toEqual(1);
    expect((dispatchWorkflow as jest.Mock).mock.calls[0][1]).toMatchObject({
      owner: UBIQUITY_OS_OWNER,
      repository: "ubiquity-os-kernel",
      workflowId: "agent.yml",
    });

    const inputs = (dispatchWorkflow as jest.Mock).mock.calls[0][1].inputs as Record<string, string>;
    const command = JSON.parse(inputs.command);
    expect(command).toMatchObject({ name: "agent", parameters: { task: "rewrite spec based on the thread and set the best time label" } });
  });

  it("Should not answer with arbitrary requests", async () => {
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const spy = jest.spyOn(issues, "createComment");

    const issueCommentCreated = (await import("../src/github/handlers/issue-comment-created")).default;
    await issueCommentCreated({
      id: "",
      key: eventName,
      octokit: {
        rest: {
          issues,
          repos: {
            getContent: jest.fn(getContent),
          },
        },
      },
      openAi,
      eventHandler: eventHandler,
      payload: {
        ...payload,
        comment: makeComment("@UbiquityOS who is the creator of the universe"),
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
      logger,
    } as unknown as GitHubContext);
    expect(spy).toBeCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      body: "Sorry, but I can't help with that.",
      issue_number: 1,
      owner: "ubiquity",
      repo: name,
    });
  });

  it("Should not post the help menu when /help command if there is no available command", async () => {
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const spy = jest.spyOn(issues, "createComment");
    const getContent = jest.fn((params?: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) => {
      if (params?.path === CONFIG_FULL_PATH) {
        return {
          data: `
          plugins:
            ubiquity-os/plugin-b: {}
          `,
        };
      } else if (params?.path === "manifest.json") {
        return {
          data: {
            content: btoa(
              JSON.stringify({
                name: "plugin",
                short_name: "plugin",
              })
            ),
          },
        };
      } else {
        throw new Error("Not found");
      }
    });
    const issueCommentCreated = (await import("../src/github/handlers/issue-comment-created")).default;
    await issueCommentCreated({
      id: "",
      key: eventName,
      octokit: {
        rest: {
          issues,
          repos: {
            getContent: getContent,
          },
        },
      },
      eventHandler: eventHandler,
      payload: {
        ...payload,
        comment: makeComment("/help"),
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
      logger,
    } as unknown as GitHubContext);
    expect(spy).not.toBeCalled();
  });
});
