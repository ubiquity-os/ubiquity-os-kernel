import { afterAll, afterEach, beforeAll, describe, expect, it } from "@jest/globals";
import { config } from "dotenv";
import { server } from "./__mocks__/node";
import "./__mocks__/webhooks";
import { CONFIG_FULL_PATH, DEV_CONFIG_FULL_PATH, getConfig } from "../src/github/utils/config";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { getManifest } from "../src/github/utils/plugins";
import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { shouldSkipPlugin } from "../src/github/handlers";

config({ path: ".dev.vars" });

const issueOpened = "issues.opened";
const manifestPath = "manifest.json";
const repo = {
  owner: { login: "ubiquity" },
  name: "conversation-rewards",
};

const eventHandler = {
  environment: "production",
} as GitHubEventHandler;

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

describe("Configuration tests", () => {
  it("Should properly parse the Action path if a branch and workflow are specified", async () => {
    function getContent(args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
      let data: string;
      if (args.path === manifestPath) {
        data = `
          {
            "name": "plugin",
            "commands": {
              "command": {
                "description": "description",
                "ubiquity:example": "example"
              }
            }
          }
          `;
      } else if (args.path === CONFIG_FULL_PATH) {
        data = `
        plugins:
          - uses:
            - plugin: ubiquity/user-activity-watcher:compute.yml@fork/pull/1
              with:
                settings1: 'enabled'
            skipBotEvents: false`;
      } else {
        throw new Error("Not Found");
      }

      if (args.mediaType === undefined || args.mediaType?.format === "base64") {
        return {
          data: {
            content: Buffer.from(data).toString("base64"),
          },
        };
      } else if (args.mediaType?.format === "raw") {
        return { data };
      }
    }

    const cfg = await getConfig({
      key: issueOpened,
      name: issueOpened,
      id: "",
      payload: {
        repository: repo,
      } as unknown as GitHubContext<"issues.closed">["payload"],
      octokit: {
        rest: {
          repos: {
            getContent,
          },
        },
      },
      eventHandler: eventHandler,
    } as unknown as GitHubContext);
    expect(cfg.plugins[0]).toEqual({
      uses: [
        {
          plugin: {
            owner: "ubiquity",
            repo: "user-activity-watcher",
            workflowId: "compute.yml",
            ref: "fork/pull/1",
          },
          runsOn: [],
          with: {
            settings1: "enabled",
          },
        },
      ],
      skipBotEvents: false,
    });
  });
  it("Should retrieve the configuration manifest from the proper branch if specified", async () => {
    let repo = "ubiquity-os-kernel";
    let ref: string | undefined = "fork/pull/1";
    const owner = "ubiquity";
    const workflowId = "compute.yml";
    const content: Record<string, object> = {
      withRef: {
        name: "plugin",
        commands: {
          command: {
            description: "description",
            "ubiquity:example": "example",
          },
        },
        configuration: {},
        description: "",
        "ubiquity:listeners": [],
      },
      withoutRef: {
        name: "plugin-no-ref",
        commands: {
          command: {
            description: "description",
            "ubiquity:example": "example",
          },
        },
        configuration: {},
        description: "",
        "ubiquity:listeners": [],
      },
    };
    function getContent({ ref }: Record<string, string>) {
      return {
        data: {
          content: Buffer.from(JSON.stringify(ref ? content["withRef"] : content["withoutRef"])).toString("base64"),
        },
      };
    }
    let manifest = await getManifest(
      {
        octokit: {
          rest: {
            repos: {
              getContent,
            },
          },
        },
      } as unknown as GitHubContext,
      { owner, repo, ref, workflowId }
    );
    expect(manifest).toEqual(content["withRef"]);
    ref = undefined;
    repo = "repo-2";
    manifest = await getManifest(
      {
        octokit: {
          rest: {
            repos: {
              getContent,
            },
          },
        },
      } as unknown as GitHubContext,
      { owner, repo, ref, workflowId }
    );
    expect(manifest).toEqual(content["withoutRef"]);
  });
  it("should not skip bot event if skipBotEvents is set to false", async () => {
    function getContent(args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
      let data: string;
      if (args.path === manifestPath) {
        data = `
          {
            "name": "plugin",
            "commands": {
              "command": {
                "description": "description",
                "ubiquity:example": "example"
              }
            }
          }
          `;
      } else if (args.path === CONFIG_FULL_PATH) {
        data = `
        plugins:
          - uses:
            - plugin: ubiquity/test-plugin
              with:
                settings1: 'enabled'
            skipBotEvents: false`;
      } else {
        throw new Error("Not Found");
      }

      if (args.mediaType === undefined || args.mediaType?.format === "base64") {
        return {
          data: {
            content: Buffer.from(data).toString("base64"),
          },
        };
      } else if (args.mediaType?.format === "raw") {
        return { data };
      }
    }

    const context = {
      key: issueOpened,
      name: issueOpened,
      id: "",
      payload: {
        repository: repo,
        sender: {
          type: "Bot",
        },
      } as unknown as GitHubContext<"issues.closed">["payload"],
      octokit: {
        rest: {
          repos: {
            getContent,
          },
        },
      },
      eventHandler: eventHandler,
    } as unknown as GitHubContext;

    const cfg = await getConfig(context);
    expect(cfg.plugins[0].skipBotEvents).toEqual(false);
    await expect(shouldSkipPlugin(context, cfg.plugins[0])).resolves.toEqual(false);
  });
  it("should return dev config if environment is not production", async () => {
    function getContent(args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
      let data: string;
      if (args.path === manifestPath) {
        data = `
          {
            "name": "plugin",
            "commands": {
              "command": {
                "description": "description",
                "ubiquity:example": "example"
              }
            }
          }
          `;
      } else if (args.path === CONFIG_FULL_PATH) {
        data = `
        plugins:
          - uses:
            - plugin: ubiquity/production-plugin
              with:
                settings1: 'enabled'`;
      } else if (args.path === DEV_CONFIG_FULL_PATH) {
        data = `
        plugins:
          - uses:
            - plugin: ubiquity/test-plugin
              with:
                settings1: 'enabled'`;
      } else {
        throw new Error("Not Found");
      }

      if (args.mediaType === undefined || args.mediaType?.format === "base64") {
        return {
          data: {
            content: Buffer.from(data).toString("base64"),
          },
        };
      } else if (args.mediaType?.format === "raw") {
        return { data };
      }
    }

    const context = {
      key: issueOpened,
      name: issueOpened,
      id: "",
      payload: {
        repository: repo,
      } as unknown as GitHubContext<"issues.closed">["payload"],
      octokit: {
        rest: {
          repos: {
            getContent,
          },
        },
      },
      eventHandler: { environment: "development" } as GitHubEventHandler,
    } as unknown as GitHubContext;

    const cfg = await getConfig(context);
    expect(cfg.plugins[0].uses[0].plugin).toMatchObject({ owner: "ubiquity", repo: "test-plugin" });

    context.eventHandler = { environment: "production" } as GitHubEventHandler;

    const cfg2 = await getConfig(context);
    expect(cfg2.plugins[0].uses[0].plugin).toMatchObject({ owner: "ubiquity", repo: "production-plugin" });
  });
});
