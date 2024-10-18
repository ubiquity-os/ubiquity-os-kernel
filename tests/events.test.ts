import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { config } from "dotenv";
import { http, HttpResponse } from "msw";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import issueCommentCreated from "../src/github/handlers/issue-comment-created";
import handlePushEvent from "../src/github/handlers/push-event";
import { CONFIG_FULL_PATH } from "../src/github/utils/config";
import { server } from "./__mocks__/node";
import "./__mocks__/webhooks";

jest.mock("@octokit/plugin-paginate-rest", () => ({}));
jest.mock("@octokit/plugin-rest-endpoint-methods", () => ({}));
jest.mock("@octokit/plugin-retry", () => ({}));
jest.mock("@octokit/plugin-throttling", () => ({}));
jest.mock("@octokit/auth-app", () => ({}));

config({ path: ".dev.vars" });

const name = "ubiquity-os-kernel";

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const eventHandler = {
  environment: "production",
} as GitHubEventHandler;

describe("Event related tests", () => {
  beforeEach(() => {
    server.use(
      http.get("https://plugin-a.internal/manifest.json", () =>
        HttpResponse.json({
          name: "plugin",
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
  it("Should post the help menu when /help command is invoked", async () => {
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const spy = jest.spyOn(issues, "createComment");
    await issueCommentCreated({
      id: "",
      key: "issue_comment.created",
      octokit: {
        rest: {
          issues,
          repos: {
            getContent(params?: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
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
                        name: "plugin",
                        commands: {
                          action: {
                            description: "action",
                            "ubiquity:example": "/action",
                          },
                        },
                      })
                    ),
                  },
                };
              } else {
                throw new Error("Not found");
              }
            },
          },
        },
      },
      eventHandler: eventHandler,
      payload: {
        repository: {
          owner: { login: "ubiquity" },
          name,
        },
        issue: { number: 1 },
        comment: {
          body: "/help",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
    } as unknown as GitHubContext);
    expect(spy).toBeCalledTimes(1);
    expect(spy.mock.calls).toEqual([
      [
        {
          body:
            "### Available Commands\n\n\n| Command | Description | Example |\n|---|---|---|\n| `/help` | List" +
            " all available commands. | `/help` |\n| `/action` | action | `/action` |\n| `/bar` | bar command | `/bar foo` |\n| `/foo` | foo command | `/foo bar` |",
          issue_number: 1,
          owner: "ubiquity",
          repo: name,
        },
      ],
    ]);
  });
  it("should handle push event correctly", async () => {
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const createCommitComment = jest.fn();
    const context = {
      id: "",
      key: "issue_comment.created",
      octokit: {
        rest: {
          issues,
          repos: {
            listCommentsForCommit: jest.fn(() => ({ data: [] })),
            createCommitComment: createCommitComment,
            getContent(params?: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
              if (params?.path === CONFIG_FULL_PATH) {
                return {
                  data: `
                    plugins:
                      - name: "Run on comment created"
                        uses:
                          - id: plugin-A
                            plugin: https://plugin-a.internal
                            with:
                              arg: "true"
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
                        commands: {
                          action: {
                            description: "action",
                            "ubiquity:example": "/action",
                          },
                        },
                        configuration: {
                          default: {},
                          type: "object",
                          properties: {
                            arg: {
                              type: "number",
                            },
                          },
                          required: ["arg"],
                        },
                      })
                    ),
                  },
                };
              } else {
                throw new Error("Not found");
              }
            },
          },
        },
      },
      eventHandler: eventHandler,
      payload: {
        repository: {
          owner: { login: "ubiquity" },
          name,
        },
        issue: { number: 1 },
        comment: {
          body: "/help",
        },
        commits: [{ modified: [CONFIG_FULL_PATH] }],
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
    } as unknown as GitHubContext;
    await expect(handlePushEvent(context)).resolves.not.toThrow();
    expect(createCommitComment).toBeCalledTimes(1);
  });
});
