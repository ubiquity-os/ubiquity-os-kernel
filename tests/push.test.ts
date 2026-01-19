import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import handlePushEvent from "../src/github/handlers/push-event";
import { CONFIG_FULL_PATH } from "../src/github/utils/config";
import { logger } from "../src/logger/logger";
import "./__mocks__/webhooks";
import { createConfigurationHandler } from "./test-utils/configuration-handler";

jest.mock("@octokit/plugin-paginate-rest", () => ({}));
jest.mock("@octokit/plugin-rest-endpoint-methods", () => ({}));
jest.mock("@octokit/plugin-retry", () => ({}));
jest.mock("@octokit/plugin-throttling", () => ({}));
jest.mock("@octokit/auth-app", () => ({}));

const name = "ubiquity-os-kernel";

afterEach(() => {
  jest.clearAllMocks();
  jest.resetAllMocks();
});

const eventHandler = {
  environment: "production",
} as GitHubEventHandler;

describe("Push related tests", () => {
  it("should handle push event correctly", async () => {
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const createCommitComment = jest.fn();
    const manifestMap = {
      "plugin-a": {
        name: "plugin",
        homepage_url: "https://plugin-a.internal",
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
      },
      "plugin-b": {
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
      },
    };

    const configurationHandler = createConfigurationHandler({
      getConfigurationFromRepo: async () => ({
        config: {
          plugins: {
            "ubiquity-os/plugin-a": {
              with: {
                arg: "true",
              },
            },
            "ubiquity-os/plugin-b": {
              with: {},
            },
          },
        },
        errors: null,
        rawData: `plugins:\n  ubiquity-os/plugin-a:\n    with:\n      arg: "true"\n  ubiquity-os/plugin-b:\n    with: {}`,
      }),
      getManifest: async (plugin) => manifestMap[plugin.repo as keyof typeof manifestMap] ?? null,
    });

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
                      ubiquity-os/plugin-a:
                        with:
                          arg: "true"
                      ubiquity-os/plugin-b:
                        with: {}
                    `,
                };
              } else if (params?.path === "manifest.json") {
                const manifest =
                  params?.repo === "plugin-a"
                    ? {
                        name: "plugin",
                        homepage_url: "https://plugin-a.internal",
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
                      }
                    : {
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
                      };
                return {
                  data: {
                    content: Buffer.from(JSON.stringify(manifest)).toString("base64"),
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
      configurationHandler,
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
      logger,
    } as unknown as GitHubContext;
    await expect(handlePushEvent(context)).resolves.not.toThrow();
    expect(createCommitComment).toBeCalledTimes(1);
  });
});
