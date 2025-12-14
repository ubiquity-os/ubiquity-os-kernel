import { afterAll, afterEach, beforeAll, describe, expect, it } from "@jest/globals";
import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { EmitterWebhookEventName } from "@octokit/webhooks";
import { config } from "dotenv";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { parsePluginIdentifier } from "../src/github/types/plugin-configuration";
import { CONFIG_FULL_PATH, DEV_CONFIG_FULL_PATH, getConfig } from "../src/github/utils/config";
import { getManifest, shouldSkipPlugin } from "../src/github/utils/plugins";
import { logger } from "../src/logger/logger";
import { server } from "./__mocks__/node";
import "./__mocks__/webhooks";

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
  it("should default to action.yml workflow for fix/action-entry refs", () => {
    expect(parsePluginIdentifier("ubiquity/test-plugin@fix/action-entry")).toMatchObject({
      owner: "ubiquity",
      repo: "test-plugin",
      workflowId: "action.yml",
      ref: "fix/action-entry",
    });
  });

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
                "ubiquity:example": "/command"
              }
            },
            "skipBotEvents": false
          }
          `;
      } else if (args.path === CONFIG_FULL_PATH) {
        data = `
        plugins:
          ubiquity/user-activity-watcher:action.yml@fork/pull/1:
            skipBotEvents: false
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
      logger,
    } as unknown as GitHubContext);
    const pluginKey = "ubiquity/user-activity-watcher:action.yml@fork/pull/1";
    expect(cfg.plugins[pluginKey]).toEqual({
      runsOn: [],
      skipBotEvents: false,
      with: {
        settings1: "enabled",
      },
    });
  });
  it("Should retrieve the configuration manifest from the proper branch if specified", async () => {
    let repo = "ubiquity-os-kernel";
    let ref: string | undefined = "fork/pull/1";
    const owner = "ubiquity";
    const workflowId = "action.yml";
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
        skipBotEvents: true,
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
        skipBotEvents: true,
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
                "ubiquity:example": "/command"
              }
            },
            "skipBotEvents": true,
            "ubiquity:listeners": ["${issueOpened}"]
          }
          `;
      } else if (args.path === CONFIG_FULL_PATH) {
        data = `
        plugins:
          ubiquity/test-plugin:
            skipBotEvents: false
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
      logger,
    } as unknown as GitHubContext;

    const cfg = await getConfig(context);
    const [pluginKey, pluginSettings] = Object.entries(cfg.plugins)[0];
    expect(pluginSettings).not.toBeNull();
    if (!pluginSettings) {
      throw new Error("Expected plugin settings");
    }
    expect(pluginSettings.skipBotEvents).toEqual(false);
    await expect(
      shouldSkipPlugin(
        context,
        {
          key: pluginKey,
          target: parsePluginIdentifier(pluginKey),
          settings: pluginSettings,
        },
        issueOpened as EmitterWebhookEventName
      )
    ).resolves.toEqual(false);
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
                "ubiquity:example": "/command"
              }
            }
          }
          `;
      } else if (args.path === CONFIG_FULL_PATH) {
        data = `
        plugins:
          ubiquity/production-plugin:
            with:
              settings1: 'enabled'`;
      } else if (args.path === DEV_CONFIG_FULL_PATH) {
        data = `
        plugins:
          ubiquity/test-plugin:
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
      logger,
    } as unknown as GitHubContext;

    const cfg = await getConfig(context);
    let [pluginKey] = Object.keys(cfg.plugins);
    expect(parsePluginIdentifier(pluginKey)).toMatchObject({ owner: "ubiquity", repo: "test-plugin" });

    context.eventHandler = { environment: "production" } as GitHubEventHandler;

    const cfg2 = await getConfig(context);
    [pluginKey] = Object.keys(cfg2.plugins);
    expect(parsePluginIdentifier(pluginKey)).toMatchObject({ owner: "ubiquity", repo: "production-plugin" });
  });
});
