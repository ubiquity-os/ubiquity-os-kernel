import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { config } from "dotenv";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { logger } from "../src/logger/logger";
import "./__mocks__/webhooks";
import { createConfigurationHandler } from "./test-utils/configuration-handler";

jest.mock("@octokit/plugin-paginate-rest", () => ({}));
jest.mock("@octokit/plugin-rest-endpoint-methods", () => ({}));
jest.mock("@octokit/plugin-retry", () => ({}));
jest.mock("@octokit/plugin-throttling", () => ({}));
jest.mock("@octokit/auth-app", () => ({}));

config({ path: ".dev.vars" });

const name = "ubiquity-os-kernel";
const eventName = "issue_comment.created";
const fooDescription = "foo command";
const barDescription = "bar command";
const helloDescription = "This command says hello to the username provided in the parameters.";
const helloExample = "/hello @pavlovcik";
const helloUsernameDescription = "the user to say hello to";

afterEach(() => {
  jest.clearAllMocks();
  jest.resetAllMocks();
  jest.resetModules();
});

const eventHandler = {
  environment: "production",
  getToken: jest.fn().mockReturnValue("1234"),
  signPayload: jest.fn().mockReturnValue("sha256=1234"),
  logger: logger,
} as unknown as GitHubEventHandler;

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
  it("Should post the help menu", async () => {
    const configurationHandler = createConfigurationHandler({
      configuration: {
        plugins: {
          "ubiquity-os/plugin-a": { with: {} },
          "ubiquity-os/plugin-b": { with: {} },
        },
      },
      manifests: {
        "plugin-a": {
          name: "plugin-A",
          homepage_url: "https://plugin-a.internal",
          commands: {
            foo: {
              description: fooDescription,
              "ubiquity:example": "/foo bar",
            },
            bar: {
              description: barDescription,
              "ubiquity:example": "/bar foo",
            },
          },
        },
        "plugin-b": {
          name: "plugin-B",
          commands: {
            hello: {
              description: helloDescription,
              "ubiquity:example": helloExample,
              parameters: {
                type: "object",
                properties: {
                  username: {
                    type: "string",
                    description: helloUsernameDescription,
                  },
                },
              },
            },
          },
        },
      },
    });

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
      eventHandler: eventHandler,
      configurationHandler,
      payload: {
        ...payload,
        comment: {
          body: "@UbiquityOS can you tell me all available commands",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
      logger: logger,
    } as unknown as GitHubContext);
    expect(spy).toBeCalledTimes(1);
    expect(spy.mock.calls).toEqual([
      [
        {
          body:
            "### Available Commands\n\n\n| Command | Description | Example |\n|---|---|---|\n| `/help` | List" +
            " all available commands. | `/help` |\n| `/bar` | bar command | `/bar foo` |\n| `/foo` | foo command | `/foo bar` |\n| `/hello` | This command says hello to the username provided in the parameters. | `/hello @pavlovcik` |",
          issue_number: 1,
          owner: "ubiquity",
          repo: name,
        },
      ],
    ]);
  });

  it("Should call appropriate plugin", async () => {
    const configurationHandler = createConfigurationHandler({
      configuration: {
        plugins: {
          "ubiquity-os/plugin-a": { with: {} },
          "ubiquity-os/plugin-b": { with: {} },
        },
      },
      manifests: {
        "plugin-a": {
          name: "plugin-A",
          commands: {
            foo: {
              description: fooDescription,
              "ubiquity:example": "/foo bar",
            },
            bar: {
              description: barDescription,
              "ubiquity:example": "/bar foo",
            },
          },
        },
        "plugin-b": {
          name: "plugin-B",
          commands: {
            hello: {
              description: helloDescription,
              "ubiquity:example": helloExample,
              parameters: {
                type: "object",
                properties: {
                  username: {
                    type: "string",
                    description: helloUsernameDescription,
                  },
                },
              },
            },
          },
        },
      },
    });

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
    const spy = jest.spyOn(issues, "createComment");

    const issueCommentCreated = (await import("../src/github/handlers/issue-comment-created")).default;
    await issueCommentCreated({
      id: "",
      key: eventName,
      octokit: {
        rest: {
          issues,
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
      eventHandler: eventHandler,
      configurationHandler,
      payload: {
        ...payload,
        comment: {
          body: "@UbiquityOS can you say hello to @pavlovcik",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
      logger,
    } as unknown as GitHubContext);
    expect(spy).toBeCalledTimes(0);
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

  it("Should not answer with arbitrary requests", async () => {
    const configurationHandler = createConfigurationHandler({
      configuration: {
        plugins: {
          "ubiquity-os/plugin-a": { with: {} },
          "ubiquity-os/plugin-b": { with: {} },
        },
      },
      manifests: {
        "plugin-a": {
          name: "plugin-A",
          commands: {
            foo: {
              description: fooDescription,
              "ubiquity:example": "/foo bar",
            },
            bar: {
              description: barDescription,
              "ubiquity:example": "/bar foo",
            },
          },
        },
        "plugin-b": {
          name: "plugin-B",
          commands: {
            hello: {
              description: helloDescription,
              "ubiquity:example": helloExample,
              parameters: {
                type: "object",
                properties: {
                  username: {
                    type: "string",
                    description: helloUsernameDescription,
                  },
                },
              },
            },
          },
        },
      },
    });

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
      eventHandler: eventHandler,
      configurationHandler,
      payload: {
        ...payload,
        comment: {
          body: "@UbiquityOS who is the creator of the universe",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
      logger,
    } as unknown as GitHubContext);
    expect(spy).toBeCalledTimes(0);
  });

  it("Should not post the help menu when /help command if there is no available command", async () => {
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const spy = jest.spyOn(issues, "createComment");
    const configurationHandler = createConfigurationHandler({
      configuration: {
        plugins: {
          "ubiquity-os/plugin-b": { with: {} },
        },
      },
      manifests: {
        "plugin-b": {
          name: "plugin",
        },
      },
    });
    const issueCommentCreated = (await import("../src/github/handlers/issue-comment-created")).default;
    await issueCommentCreated({
      id: "",
      key: eventName,
      octokit: {
        rest: {
          issues,
        },
      },
      eventHandler: eventHandler,
      configurationHandler,
      payload: {
        ...payload,
        comment: {
          body: "/help",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
      logger,
    } as unknown as GitHubContext);
    expect(spy).not.toBeCalled();
  });
});
