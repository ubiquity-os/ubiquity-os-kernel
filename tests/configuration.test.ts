import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { EmitterWebhookEventName } from "@octokit/webhooks";
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { GitHubContext } from "../src/github/github-context.ts";
import { GitHubEventHandler } from "../src/github/github-event-handler.ts";
import { parsePluginIdentifier } from "../src/github/types/plugin-configuration.ts";
import { CONFIG_FULL_PATH, DEV_CONFIG_FULL_PATH, getConfig, getConfigFullPathForEnvironment } from "../src/github/utils/config.ts";
import { getManifest, shouldSkipPlugin } from "../src/github/utils/plugins.ts";
import { logger } from "../src/logger/logger.ts";

const issueOpened = "issues.opened";
const manifestPath = "manifest.json";
const EXPECTED_GITHUB_PLUGIN_IDENTIFIER_ERROR = "Expected GitHub plugin identifier";
const repo = {
  owner: { login: "ubiquity" },
  name: "conversation-rewards",
};

const eventHandler = {
  environment: "production",
} as GitHubEventHandler;

type LogEntry = {
  level: string;
  message: string;
  metadata?: Record<string, unknown>;
};

function createNotFoundError() {
  const error = new Error("Not Found") as Error & { status: number };
  error.status = 404;
  return error;
}

function createTestLogger() {
  const entries: LogEntry[] = [];
  const capture =
    (level: string) =>
    (...args: unknown[]) => {
      const message = [...args].reverse().find((value): value is string => typeof value === "string") ?? "";
      const metadata = args.find((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value));
      entries.push({ level, message, metadata });
    };

  return {
    entries,
    logger: {
      trace: capture("trace"),
      debug: capture("debug"),
      info: capture("info"),
      warn: capture("warn"),
      error: capture("error"),
      github: capture("github"),
    },
  };
}

Deno.test("Configuration: defaults to compute.yml workflow when none is provided", () => {
  assertEquals(parsePluginIdentifier("ubiquity/test-plugin@fix/action-entry"), {
    owner: "ubiquity",
    repo: "test-plugin",
    workflowId: "compute.yml",
    ref: "fix/action-entry",
  });
});

Deno.test("Configuration: parses Action path when branch and workflow are specified", async () => {
  function getContent(args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
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
  name: "Configuration: getConfig prefers dist/<ref> during SDK manifest enrichment",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const refsTried: string[] = [];
    const { entries, logger: testLogger } = createTestLogger();
    const pluginKey = "ubiquity/test-plugin:action.yml@feature/test";

    function getContent(args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
      if (args.path === manifestPath) {
        refsTried.push(String(args.ref));
        if (args.ref === "dist/feature/test") {
          const data = JSON.stringify({
            name: "plugin",
            short_name: "ubiquity/test-plugin@feature/test",
            description: "plugin fixture",
            commands: {},
            "ubiquity:listeners": [issueOpened],
            skipBotEvents: false,
          });
          return {
            data: {
              content: btoa(data),
            },
          };
        }
        throw createNotFoundError();
      }

      if (args.path === CONFIG_FULL_PATH && args.repo === repo.name) {
        const data = `plugins:
  ${pluginKey}:`;
        return args.mediaType?.format === "raw" ? { data } : { data: { content: btoa(data) } };
      }

      throw createNotFoundError();
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
      eventHandler,
      logger: testLogger,
    } as unknown as GitHubContext);

    assertEquals(cfg.plugins[pluginKey], {
      with: {},
      runsOn: [issueOpened],
      skipBotEvents: false,
    });
    assertEquals(refsTried, ["dist/feature/test"]);
    assertEquals(
      entries.some((entry) => entry.message.includes("Could not find a valid manifest")),
      false
    );
  },
});

Deno.test({
  name: "Configuration: getConfig falls back to source ref after dist 404 without logging manifest not found",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const refsTried: string[] = [];
    const { entries, logger: testLogger } = createTestLogger();
    const pluginKey = "ubiquity/fallback-plugin:action.yml@feature/fallback";

    function getContent(args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
      if (args.path === manifestPath) {
        refsTried.push(String(args.ref));
        if (args.ref === "feature/fallback") {
          const data = JSON.stringify({
            name: "plugin",
            short_name: "ubiquity/fallback-plugin@feature/fallback",
            description: "plugin fixture",
            commands: {},
            "ubiquity:listeners": [issueOpened],
            skipBotEvents: false,
          });
          return {
            data: {
              content: btoa(data),
            },
          };
        }
        throw createNotFoundError();
      }

      if (args.path === CONFIG_FULL_PATH && args.repo === repo.name) {
        const data = `plugins:
  ${pluginKey}:`;
        return args.mediaType?.format === "raw" ? { data } : { data: { content: btoa(data) } };
      }

      throw createNotFoundError();
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
      eventHandler,
      logger: testLogger,
    } as unknown as GitHubContext);

    assertEquals(cfg.plugins[pluginKey], {
      with: {},
      runsOn: [issueOpened],
      skipBotEvents: false,
    });
    assertEquals(refsTried, ["dist/feature/fallback", "feature/fallback"]);
    assertEquals(
      entries.some((entry) => entry.message.includes("Could not find a valid manifest")),
      false
    );
    assertEquals(
      entries.some((entry) => entry.message.includes("Could not find a manifest for Action")),
      false
    );
  },
});

Deno.test({
  name: "Configuration: retrieves the configuration manifest from the proper branch if specified",
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
          content: btoa(JSON.stringify(ref ? content["withRef"] : content["withoutRef"])),
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
      { owner, repo, ref, workflowId }
    );
    assertEquals(manifest, content["withoutRef"]);
  },
});

Deno.test("Configuration: does not skip bot event when skipBotEvents is set to false", async () => {
  function getContent(args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
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
      issueOpened as EmitterWebhookEventName
    ),
    false
  );
});

Deno.test({
  name: "Configuration: selects config by environment suffix",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const testConfigPath = getConfigFullPathForEnvironment("test");
    function getContent(args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
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
