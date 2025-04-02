import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { config } from "dotenv";
import { http, HttpResponse } from "msw";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { CONFIG_FULL_PATH } from "../src/github/utils/config";
import { server } from "./__mocks__/node";
import "./__mocks__/webhooks";
import { Context } from "@ubiquity-os/plugin-sdk";
import { LogReturn, Logs } from "@ubiquity-os/ubiquity-os-logger";

jest.mock("@octokit/plugin-paginate-rest", () => ({}));
jest.mock("@octokit/plugin-rest-endpoint-methods", () => ({}));
jest.mock("@octokit/plugin-retry", () => ({}));
jest.mock("@octokit/plugin-throttling", () => ({}));
jest.mock("@octokit/auth-app", () => ({}));

config({ path: ".dev.vars" });

const name = "ubiquity-os-kernel";
const eventName = "issue_comment.created";

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
} as unknown as GitHubEventHandler;

function getContent(params?: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
  if (params?.path === CONFIG_FULL_PATH) {
    return {
      data: `
      plugins:
        - name: "Run on comment created"
          uses:
            - id: plugin-A
              plugin: https://plugin-a.internal
        - name: "Some Action plugin"
          uses:
            - id: plugin-B
              plugin: ubiquity-os/plugin-b
      `,
    };
  } else if (params?.path === "manifest.json") {
    return {
      data: {
        content: btoa(
          JSON.stringify({
            name: "plugin-B",
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
    server.use(
      http.get("https://plugin-a.internal/manifest.json", () =>
        HttpResponse.json({
          name: "plugin-A",
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
  });

  it("Should post the help menu", async () => {
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const commentHandlerSpy = jest.fn((context: Context, message: LogReturn) => {
      return {
        id: 1,
        sender: context.payload.sender,
        body: message.logMessage.raw,
      };
    });

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
      openAi: {
        chat: {
          completions: {
            create: function () {
              return {
                choices: [
                  {
                    message: {
                      tool_calls: [
                        {
                          type: "function",
                          function: {
                            name: "help",
                            arguments: "",
                          },
                        },
                      ],
                    },
                  },
                ],
              };
            },
          },
        },
      },
      voyageAiClient: {
        embed: jest.fn().mockImplementation(() => {
          return {
            data: [
              {
                embedding: [0.1, 0.2, 0.3],
              },
            ],
          };
        }),
      },
      eventHandler: eventHandler,
      logger: new Logs("debug"),
      commentHandler: {
        postComment: commentHandlerSpy,
      },
      payload: {
        ...payload,
        comment: {
          body: "@UbiquityOS can you tell me all available commands",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
    } as unknown as GitHubContext);
    expect(commentHandlerSpy).toBeCalledTimes(1);
    expect(commentHandlerSpy.mock.calls[0][1].logMessage.raw).toBe(
      "### Available Commands\n\n\n| Command | Description | Example |\n|---|---|---|\n| `/help` | List" +
        " all available commands. | `/help` |\n| `/bar` | bar command | `/bar foo` |\n| `/foo` | foo command | `/foo bar` |\n| `/hello` | This command says hello to the username provided in the parameters. | `/hello @pavlovcik` |"
    );
  });

  it("Should call appropriate plugin", async () => {
    const dispatchWorkflow = jest.fn();
    jest.mock("../src/github/utils/workflow-dispatch", () => ({
      getDefaultBranch: jest.fn().mockImplementation(() => Promise.resolve("main")),
      dispatchWorkflow: dispatchWorkflow,
    }));

    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const commentHandlerSpy = jest.fn((context: Context, message: LogReturn) => {
      return {
        id: 1,
        sender: context.payload.sender,
        body: message.logMessage.raw,
      };
    });

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
      openAi: {
        chat: {
          completions: {
            create: function () {
              return {
                choices: [
                  {
                    message: {
                      tool_calls: [
                        {
                          type: "function",
                          function: {
                            name: "hello",
                            arguments: JSON.stringify({ username: "pavlovcik" }),
                          },
                        },
                      ],
                    },
                  },
                ],
              };
            },
          },
        },
      },
      voyageAiClient: {
        embed: jest.fn().mockImplementation(() => {
          return {
            data: [
              {
                embedding: [0.1, 0.2, 0.3],
              },
            ],
          };
        }),
      },
      eventHandler: eventHandler,
      logger: new Logs("debug"),
      commentHandler: {
        postComment: commentHandlerSpy,
      },
      payload: {
        ...payload,
        comment: {
          body: "@UbiquityOS can you say hello to @pavlovcik",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
    } as unknown as GitHubContext);
    expect(commentHandlerSpy).toBeCalledTimes(0);
    expect(dispatchWorkflow.mock.calls.length).toEqual(1);
    expect(dispatchWorkflow.mock.calls[0][1]).toMatchObject({
      owner: "ubiquity-os",
      repository: "plugin-b",
      ref: "main",
      workflowId: "compute.yml",
      inputs: {
        command: JSON.stringify({ name: "hello", parameters: { username: "pavlovcik" } }),
      },
    });
  });

  it("Should handle tool call schema validation failures", async () => {
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const commentHandlerSpy = jest.fn((context: Context, message: LogReturn) => {
      return {
        id: 1,
        sender: context.payload.sender,
        body: message.logMessage.raw,
      };
    });

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
      openAi: {
        chat: {
          completions: {
            create: function () {
              return {
                choices: [
                  {
                    message: {
                      tool_calls: [
                        {
                          type: "function",
                          function: {
                            // Missing required 'name' field
                            arguments: "{}",
                          },
                        },
                      ],
                    },
                  },
                ],
              };
            },
          },
        },
      },
      voyageAiClient: {
        embed: jest.fn().mockImplementation(() => {
          return {
            data: [
              {
                embedding: [0.1, 0.2, 0.3],
              },
            ],
          };
        }),
      },
      eventHandler: eventHandler,
      logger: new Logs("debug"),
      commentHandler: {
        postComment: commentHandlerSpy,
      },
      payload: {
        ...payload,
        comment: {
          body: "@UbiquityOS can you say hello",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
    } as unknown as GitHubContext);

    expect(commentHandlerSpy).toBeCalledTimes(1);
    expect(commentHandlerSpy.mock.calls[0][1].logMessage.raw).toBe("I apologize, but I encountered an error processing your command. Please try again.");
  }, 100000);

  it("Should retry LLM call with error feedback when tool parsing fails", async () => {
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const commentHandlerSpy = jest.fn((context: Context, message: LogReturn) => {
      return {
        id: 1,
        sender: context.payload.sender,
        body: message.logMessage.raw,
      };
    });
    const dispatchWorkflow = jest.fn();
    jest.mock("../src/github/utils/workflow-dispatch", () => ({
      getDefaultBranch: jest.fn().mockImplementation(() => Promise.resolve("main")),
      dispatchWorkflow: dispatchWorkflow,
    }));

    let attempts = 0;

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
      openAi: {
        chat: {
          completions: {
            create: function () {
              attempts++;
              // First attempt: Missing name field
              if (attempts === 1) {
                return {
                  choices: [
                    {
                      message: {
                        tool_calls: [
                          {
                            type: "function",
                            function: {
                              arguments: "{}",
                            },
                          },
                        ],
                      },
                    },
                  ],
                };
              }

              // Second attempt: Invalid JSON
              if (attempts === 2) {
                return {
                  choices: [
                    {
                      message: {
                        tool_calls: [
                          {
                            type: "function",
                            function: {
                              name: "hello",
                              arguments: "{invalid",
                            },
                          },
                        ],
                      },
                    },
                  ],
                };
              }

              // Third attempt: Valid response
              return {
                choices: [
                  {
                    message: {
                      tool_calls: [
                        {
                          type: "function",
                          function: {
                            name: "hello",
                            arguments: JSON.stringify({ username: "testuser" }),
                          },
                        },
                      ],
                    },
                  },
                ],
              };
            },
          },
        },
      },
      voyageAiClient: {
        embed: jest.fn().mockImplementation(() => {
          return {
            data: [
              {
                embedding: [0.1, 0.2, 0.3],
              },
            ],
          };
        }),
      },
      eventHandler: eventHandler,
      logger: new Logs("debug"),
      commentHandler: {
        postComment: commentHandlerSpy,
      },
      payload: {
        ...payload,
        comment: {
          body: "@UbiquityOS say hello to @testuser",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
    } as unknown as GitHubContext);

    expect(attempts).toBe(3); // Should make three attempts (2 failures, 1 success)
    expect(commentHandlerSpy).not.toBeCalled(); // Should not show error message on successful retry
    expect(dispatchWorkflow).toBeCalledTimes(1); // Should execute the command on successful retry
    expect(dispatchWorkflow.mock.calls[0][1]).toMatchObject({
      owner: "ubiquity-os",
      repository: "plugin-b",
      ref: "main",
      workflowId: "compute.yml",
      inputs: {
        command: JSON.stringify({ name: "hello", parameters: { username: "testuser" } }),
      },
    });
  });

  it("Should handle invalid JSON in tool calls", async () => {
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const commentHandlerSpy = jest.fn((context: Context, message: LogReturn) => {
      return {
        id: 1,
        sender: context.payload.sender,
        body: message.logMessage.raw,
      };
    });

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
      openAi: {
        chat: {
          completions: {
            create: function () {
              return {
                choices: [
                  {
                    message: {
                      tool_calls: [
                        {
                          type: "function",
                          function: {
                            name: "hello",
                            arguments: "{invalid json",
                          },
                        },
                      ],
                    },
                  },
                ],
              };
            },
          },
        },
      },
      voyageAiClient: {
        embed: jest.fn().mockImplementation(() => {
          return {
            data: [
              {
                embedding: [0.1, 0.2, 0.3],
              },
            ],
          };
        }),
      },
      eventHandler: eventHandler,
      logger: new Logs("debug"),
      commentHandler: {
        postComment: commentHandlerSpy,
      },
      payload: {
        ...payload,
        comment: {
          body: "@UbiquityOS can you say hello to @0x4007",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
    } as unknown as GitHubContext);

    expect(commentHandlerSpy).toBeCalledTimes(1);
    expect(commentHandlerSpy.mock.calls[0][1].logMessage.raw).toBe("I apologize, but I encountered an error processing your command. Please try again.");
  }, 100000);

  it("Should tell the user it cannot help with arbitrary requests", async () => {
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const commentHandlerSpy = jest.fn((context: Context, message: LogReturn) => {
      return {
        id: 1,
        sender: context.payload.sender,
        body: message.logMessage.raw,
      };
    });

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
      openAi: {
        chat: {
          completions: {
            create: function () {
              return {
                choices: [
                  {
                    message: {
                      content: "Sorry, but I can't help with that.",
                    },
                  },
                ],
              };
            },
          },
        },
      },
      voyageAiClient: {
        embed: jest.fn().mockImplementation(() => {
          return {
            data: [
              {
                embedding: [0.1, 0.2, 0.3],
              },
            ],
          };
        }),
      },
      eventHandler: eventHandler,
      logger: new Logs("debug"),
      commentHandler: {
        postComment: commentHandlerSpy,
      },
      payload: {
        ...payload,
        comment: {
          body: "@UbiquityOS who is the creator of the universe",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
    } as unknown as GitHubContext);
    expect(commentHandlerSpy).toBeCalledTimes(1);
    expect(commentHandlerSpy.mock.calls[0][1].logMessage.raw).toBe("Sorry, but I can't help with that.");
  });

  it("Should not post the help menu when /help command if there is no available command", async () => {
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const commentHandlerSpy = jest.fn((context: Context, message: LogReturn) => {
      return {
        id: 1,
        sender: context.payload.sender,
        body: message.logMessage.raw,
      };
    });
    const getContent = jest.fn((params?: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) => {
      if (params?.path === CONFIG_FULL_PATH) {
        return {
          data: `
          plugins:
            - name: "Some Action plugin"
              uses:
                - id: plugin-B
                  plugin: ubiquity-os/plugin-b
          `,
        };
      } else if (params?.path === "manifest.json") {
        return {
          data: {
            content: btoa(
              JSON.stringify({
                name: "plugin",
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
      logger: new Logs("debug"),
      commentHandler: {
        postComment: commentHandlerSpy,
      },
      payload: {
        ...payload,
        comment: {
          body: "/help",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
    } as unknown as GitHubContext);
    expect(commentHandlerSpy).not.toBeCalled();
  });
});
