import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { EmitterWebhookEventName } from "@octokit/webhooks";
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { GitHubContext } from "../src/github/github-context.ts";
import { GitHubEventHandler } from "../src/github/github-event-handler.ts";
import { parsePluginIdentifier } from "../src/github/types/plugin-configuration.ts";
import {
  CONFIG_FULL_PATH,
  DEV_CONFIG_FULL_PATH,
  getConfig,
  getConfigFullPathForEnvironment,
} from "../src/github/utils/config.ts";
import { getManifest, shouldSkipPlugin } from "../src/github/utils/plugins.ts";
import { logger } from "../src/logger/logger.ts";

const issueOpened = "issues.opened";
const manifestPath = "manifest.json";
const EXPECTED_GITHUB_PLUGIN_IDENTIFIER_ERROR =
  "Expected GitHub plugin identifier";
const repo = {
  owner: { login: "ubiquity" },
  name: "conversation-rewards",
};

const eventHandler = {
  environment: "production",
} as GitHubEventHandler;

Deno.test("Configuration: defaults to compute.yml workflow when none is provided", () => {
  assertEquals(parsePluginIdentifier("ubiquity/test-plugin@fix/action-entry"), {
    owner: "ubiquity",
    repo: "test-plugin",
    workflowId: "compute.yml",
    ref: "fix/action-entry",
  });
});

Deno.test("Configuration: parses Action path when branch and workflow are specified", async () => {
  function getContent(
    args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"],
  ) {
    let data: string;
    if (args.path === manifestPath) {
      data = `
          {
            "name": "plugin",
            "short_name": "plugin",
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
          content: btoa(data),
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
  assertEquals(cfg.plugins[pluginKey], {
    runsOn: [],
    skipBotEvents: false,
    with: {
      settings1: "enabled",
    },
  });
});

Deno.test({
  name:
    "Configuration: retrieves the configuration manifest from the proper branch if specified",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let repo = "ubiquity-os-kernel";
    let ref: string | undefined = "fork/pull/1";
    const owner = "ubiquity";
    const workflowId = "action.yml";
    const content: Record<string, object> = {
      withRef: {
        name: "plugin",
        short_name: "plugin",
        homepage_url: "",
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
        short_name: "plugin-no-ref",
        homepage_url: "",
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
          content: btoa(
            JSON.stringify(ref ? content["withRef"] : content["withoutRef"]),
          ),
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
      { owner, repo, ref, workflowId },
    );
    assertEquals(manifest, content["withRef"]);
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
      { owner, repo, ref, workflowId },
    );
    assertEquals(manifest, content["withoutRef"]);
  },
});

Deno.test({
  name: "Configuration: prefers dist/<ref> for GitHub plugin manifests",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const owner = "ubiquity";
    const repo = "ubiquity-os-kernel";
    const workflowId = "action.yml";
    const calls: Array<string | undefined> = [];
    const content = {
      name: "plugin-dist",
      short_name: "plugin-dist",
      homepage_url: "",
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
    };

    function getContent({ ref }: Record<string, string | undefined>) {
      calls.push(ref);
      if (ref !== "dist/feature/ref") {
        throw { status: 404 };
      }
      return {
        data: {
          content: btoa(JSON.stringify(content)),
        },
      };
    }

    const manifest = await getManifest(
      {
        octokit: {
          rest: {
            repos: {
              getContent,
            },
          },
        },
      } as unknown as GitHubContext,
      { owner, repo, ref: "feature/ref", workflowId },
    );

    assertEquals(manifest, content);
    assertEquals(calls, ["dist/feature/ref"]);
  },
});

Deno.test({
  name:
    "Configuration: falls back to source ref when dist/<ref> manifest is missing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const owner = "ubiquity";
    const repo = "ubiquity-os-kernel";
    const workflowId = "action.yml";
    const calls: Array<string | undefined> = [];
    const sourceManifest = {
      name: "plugin-source",
      short_name: "plugin-source",
      homepage_url: "",
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
    };

    function getContent({ ref }: Record<string, string | undefined>) {
      calls.push(ref);
      if (ref === "dist/feature/ref") {
        throw { status: 404 };
      }
      if (ref === "feature/ref") {
        return {
          data: {
            content: btoa(JSON.stringify(sourceManifest)),
          },
        };
      }
      throw { status: 404 };
    }

    const manifest = await getManifest(
      {
        octokit: {
          rest: {
            repos: {
              getContent,
            },
          },
        },
      } as unknown as GitHubContext,
      { owner, repo, ref: "feature/ref", workflowId },
    );

    assertEquals(manifest, sourceManifest);
    assertEquals(calls, ["dist/feature/ref", "feature/ref"]);
  },
});

Deno.test({
  name: "Configuration: does not rewrite dist/* refs when resolving manifests",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const owner = "ubiquity";
    const repo = "ubiquity-os-kernel";
    const workflowId = "action.yml";
    const calls: Array<string | undefined> = [];
    const content = {
      name: "plugin-dist-ref",
      short_name: "plugin-dist-ref",
      homepage_url: "",
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
    };

    function getContent({ ref }: Record<string, string | undefined>) {
      calls.push(ref);
      if (ref !== "dist/feature/ref") {
        throw { status: 404 };
      }
      return {
        data: {
          content: btoa(JSON.stringify(content)),
        },
      };
    }

    const manifest = await getManifest(
      {
        octokit: {
          rest: {
            repos: {
              getContent,
            },
          },
        },
      } as unknown as GitHubContext,
      { owner, repo, ref: "dist/feature/ref", workflowId },
    );

    assertEquals(manifest, content);
    assertEquals(calls, ["dist/feature/ref"]);
  },
});

Deno.test("Configuration: does not skip bot event when skipBotEvents is set to false", async () => {
  function getContent(
    args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"],
  ) {
    let data: string;
    if (args.path === manifestPath) {
      data = `
          {
            "name": "plugin",
            "short_name": "plugin",
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
          content: btoa(data),
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
  assertNotEquals(pluginSettings, null);
  if (!pluginSettings) {
    throw new Error("Expected plugin settings");
  }
  assertEquals(pluginSettings.skipBotEvents, false);
  assertEquals(
    await shouldSkipPlugin(
      context,
      {
        key: pluginKey,
        target: parsePluginIdentifier(pluginKey),
        settings: pluginSettings,
      },
      issueOpened as EmitterWebhookEventName,
    ),
    false,
  );
});

Deno.test({
  name: "Configuration: selects config by environment suffix",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const testConfigPath = getConfigFullPathForEnvironment("test");
    function getContent(
      args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"],
    ) {
      let data: string;
      if (args.path === manifestPath) {
        data = `
          {
            "name": "plugin",
            "short_name": "plugin",
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
      } else if (args.path === testConfigPath) {
        data = `
        plugins:
          ubiquity/test-env-plugin:
            with:
              settings1: 'enabled'`;
      } else {
        throw new Error("Not Found");
      }

      if (args.mediaType === undefined || args.mediaType?.format === "base64") {
        return {
          data: {
            content: btoa(data),
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
    {
      const parsed = parsePluginIdentifier(pluginKey);
      if (typeof parsed === "string") {
        throw new Error(EXPECTED_GITHUB_PLUGIN_IDENTIFIER_ERROR);
      }
      assertEquals(parsed.owner, "ubiquity");
      assertEquals(parsed.repo, "test-plugin");
    }

    context.eventHandler = { environment: "test" } as GitHubEventHandler;

    const cfgTest = await getConfig(context);
    [pluginKey] = Object.keys(cfgTest.plugins);
    {
      const parsed = parsePluginIdentifier(pluginKey);
      if (typeof parsed === "string") {
        throw new Error(EXPECTED_GITHUB_PLUGIN_IDENTIFIER_ERROR);
      }
      assertEquals(parsed.owner, "ubiquity");
      assertEquals(parsed.repo, "test-env-plugin");
    }

    context.eventHandler = { environment: "production" } as GitHubEventHandler;

    const cfg2 = await getConfig(context);
    [pluginKey] = Object.keys(cfg2.plugins);
    {
      const parsed = parsePluginIdentifier(pluginKey);
      if (typeof parsed === "string") {
        throw new Error(EXPECTED_GITHUB_PLUGIN_IDENTIFIER_ERROR);
      }
      assertEquals(parsed.owner, "ubiquity");
      assertEquals(parsed.repo, "production-plugin");
    }
  },
});
