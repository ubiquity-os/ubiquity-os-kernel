import { afterAll, afterEach, beforeAll, describe, expect, it } from "@jest/globals";
import { EmitterWebhookEventName } from "@octokit/webhooks";
import { config } from "dotenv";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { parsePluginIdentifier } from "../src/github/types/plugin-configuration";
import { getConfig } from "../src/github/utils/config";
import { getManifest, shouldSkipPlugin } from "../src/github/utils/plugins";
import { logger } from "../src/logger/logger";
import { server } from "./__mocks__/node";
import "./__mocks__/webhooks";
import { createConfigurationHandler } from "./test-utils/configuration-handler";
import { ConfigurationHandler } from "@ubiquity-os/plugin-sdk/configuration";

config({ path: ".dev.vars" });

const issueOpened = "issues.opened";
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
    const configurationHandler = createConfigurationHandler({
      configuration: {
        plugins: {
          "ubiquity/user-activity-watcher:compute.yml@fork/pull/1": {
            skipBotEvents: false,
            with: {
              settings1: "enabled",
            },
            runsOn: [],
          },
        },
      },
      manifests: {
        "user-activity-watcher": {
          name: "plugin",
          commands: {
            command: {
              description: "description",
              "ubiquity:example": "/command",
            },
          },
          skipBotEvents: false,
        },
      },
    });

    const cfg = await getConfig({
      key: issueOpened,
      name: issueOpened,
      id: "",
      payload: {
        repository: repo,
      } as unknown as GitHubContext<"issues.closed">["payload"],
      octokit: {},
      configurationHandler,
      eventHandler: eventHandler,
      logger,
    } as unknown as GitHubContext);
    const pluginKey = "ubiquity/user-activity-watcher:compute.yml@fork/pull/1";
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
    const configurationHandler = createConfigurationHandler({
      getManifest: async ({ ref: manifestRef }: { ref?: string }) => {
        return manifestRef ? content["withRef"] : content["withoutRef"];
      },
    });
    let manifest = await getManifest(
      {
        configurationHandler,
      } as unknown as GitHubContext,
      { owner, repo, ref, workflowId }
    );
    expect(manifest).toEqual(content["withRef"]);
    ref = undefined;
    repo = "repo-2";
    manifest = await getManifest({ configurationHandler } as unknown as GitHubContext, { owner, repo, ref, workflowId });
    expect(manifest).toEqual(content["withoutRef"]);
  });
  it("should not skip bot event if skipBotEvents is set to false", async () => {
    const configurationHandler = createConfigurationHandler({
      configuration: {
        plugins: {
          "ubiquity/test-plugin": {
            skipBotEvents: false,
            with: {
              settings1: "enabled",
            },
          },
        },
      },
      manifests: {
        "test-plugin": {
          name: "plugin",
          commands: {
            command: {
              description: "description",
              "ubiquity:example": "/command",
            },
          },
          skipBotEvents: true,
          "ubiquity:listeners": [issueOpened],
        },
      },
    });

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
      octokit: {},
      eventHandler: eventHandler,
      logger,
      configurationHandler,
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
    const manifest = {
      name: "plugin",
      commands: {
        command: {
          description: "description",
          "ubiquity:example": "/command",
        },
      },
    };
    const devConfig = {
      plugins: {
        "ubiquity/test-plugin": {
          with: {
            settings1: "enabled",
          },
        },
      },
    };
    const prodConfig = {
      plugins: {
        "ubiquity/production-plugin": {
          with: {
            settings1: "enabled",
          },
        },
      },
    };

    const context = {
      key: issueOpened,
      name: issueOpened,
      id: "",
      payload: {
        repository: repo,
      } as unknown as GitHubContext<"issues.closed">["payload"],
      octokit: {},
      eventHandler: { environment: "development" } as GitHubEventHandler,
      logger,
    } as unknown as GitHubContext;

    context.configurationHandler = createConfigurationHandler({
      getConfiguration: async () => (context.eventHandler.environment === "development" ? devConfig : prodConfig),
      manifests: {
        "test-plugin": manifest,
        "production-plugin": manifest,
      },
    }) as unknown as ConfigurationHandler;

    const cfg = await getConfig(context);
    let [pluginKey] = Object.keys(cfg.plugins);
    expect(parsePluginIdentifier(pluginKey)).toMatchObject({ owner: "ubiquity", repo: "test-plugin" });

    context.eventHandler = { environment: "production" } as GitHubEventHandler;

    const cfg2 = await getConfig(context);
    [pluginKey] = Object.keys(cfg2.plugins);
    expect(parsePluginIdentifier(pluginKey)).toMatchObject({ owner: "ubiquity", repo: "production-plugin" });
  });
});
