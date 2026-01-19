import type { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { assertEquals } from "jsr:@std/assert";

import type { GitHubContext } from "../src/github/github-context.ts";
import type { GitHubEventHandler } from "../src/github/github-event-handler.ts";
import handlePushEvent from "../src/github/handlers/push-event.ts";
import { CONFIG_FULL_PATH } from "../src/github/utils/config.ts";
import { logger } from "../src/logger/logger.ts";
import { createConfigurationHandler } from "./test-utils/configuration-handler.ts";

const name = "ubiquity-os-kernel";

const eventHandler = {
  environment: "production",
} as GitHubEventHandler;

Deno.test("should handle push event correctly", async () => {
  const issues = {
    createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
      return params;
    },
  };
  let createCommitCommentCalls = 0;
  const createCommitComment = async () => {
    createCommitCommentCalls += 1;
    return {};
  };
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
          listCommentsForCommit: () => ({ data: [] }),
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
                  content: btoa(JSON.stringify(manifest)),
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
  await handlePushEvent(context);
  assertEquals(createCommitCommentCalls, 1);
});
