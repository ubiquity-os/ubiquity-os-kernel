import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { stubFetch } from "./test-utils/fetch-stub.ts";

import type { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import process from "node:process";
import type { GitHubContext } from "../src/github/github-context.ts";
import type { GitHubEventHandler } from "../src/github/github-event-handler.ts";
import { getConfig } from "../src/github/utils/config.ts";
import { app } from "../src/kernel.ts";

const logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  github: () => {},
} as never;

const issueOpened = "issues.opened";
const conversationRewardsRepo = "conversation-rewards";
const ISSUE_COMMENT_CREATED = "issue_comment.created";
const COMMAND_EXAMPLE = "/command";
const NOT_FOUND_ERROR = "Not Found";
const CONFIG_ORG_REPO = ".ubiquity-os";
const DEV_CONFIG_PATH = ".github/.ubiquity-os.config.dev.yml";

const eventHandler = {
  environment: "production",
} as GitHubEventHandler;

function stubPluginAlphaManifest() {
  return stubFetch({
    "https://plugin-a.internal/manifest.json": new Response(
      JSON.stringify({
        name: "plugin",
        short_name: "plugin",
        homepage_url: "",
        description: "plugin-a for tests",
        "ubiquity:listeners": [ISSUE_COMMENT_CREATED],
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
      }),
      { headers: { "content-type": "application/json" } }
    ),
    "https://plugin-a.internal//manifest.json": new Response(
      JSON.stringify({
        name: "plugin",
        short_name: "plugin",
        homepage_url: "",
        description: "plugin-a for tests",
        "ubiquity:listeners": [ISSUE_COMMENT_CREATED],
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
      }),
      { headers: { "content-type": "application/json" } }
    ),
  });
}

Deno.test("kernel: fails on missing env variables", async () => {
  const originalEnv = { ...process.env };
  try {
    process.env = {
      ENVIRONMENT: "production",
      APP_WEBHOOK_SECRET: "",
      APP_ID: "",
      APP_PRIVATE_KEY: "",
    } as never;
    const res = await app.request("http://localhost:8080", { method: "POST" });
    assertEquals(res.status, 500);
    const json = await res.json();
    assertStringIncludes(String((json as { error: string })?.error ?? ""), "Unable to decode value");
  } finally {
    process.env = originalEnv;
  }
});

Deno.test("getConfig: generates default configuration when no repo defined", async () => {
  const fetchStub = stubPluginAlphaManifest();
  try {
    const cfg = await getConfig({
      key: issueOpened,
      name: issueOpened,
      id: "",
      payload: {
        repository: "",
      },
      octokit: {},
      eventHandler: eventHandler,
      logger,
    } as unknown as GitHubContext);
    assertEquals(Boolean(cfg), true);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("getConfig: generates default configuration when target repo lacks one", async () => {
  const fetchStub = stubPluginAlphaManifest();
  try {
    const cfg = await getConfig({
      key: issueOpened,
      name: issueOpened,
      id: "",
      payload: {
        repository: {
          owner: { login: "ubiquity" },
          name: "ubiquity-os-kernel",
        },
      } as unknown as GitHubContext<"issues.closed">["payload"],
      octokit: {
        rest: {
          repos: {
            getContent() {
              return { data: null };
            },
          },
        },
      },
      eventHandler: eventHandler,
      logger,
    } as unknown as GitHubContext);
    assertEquals(Boolean(cfg), true);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("getConfig: fills plugin config with defaults", async () => {
  const fetchStub = stubPluginAlphaManifest();
  try {
    const cfg = await getConfig({
      key: issueOpened,
      name: issueOpened,
      id: "",
      payload: {
        repository: {
          owner: { login: "ubiquity" },
          name: "ubiquity-os-kernel",
        },
      } as unknown as GitHubContext<"issues.closed">["payload"],
      octokit: {
        rest: {
          repos: {
            getContent() {
              return {
                data: `
                plugins:
                  https://plugin-a.internal:
                    with: {}
                `,
              };
            },
          },
        },
      },
      eventHandler: eventHandler,
      logger,
    } as unknown as GitHubContext);
    assertEquals(Boolean(cfg), true);
    assertEquals(cfg.plugins, {
      "https://plugin-a.internal": {
        runsOn: [ISSUE_COMMENT_CREATED],
        skipBotEvents: true,
        with: {},
      },
    });
  } finally {
    fetchStub.restore();
  }
});

Deno.test("getConfig: merges organization and repository configuration", async () => {
  const fetchStub = stubPluginAlphaManifest();
  try {
    function getContent(args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
      let data: string;
      if (args.path === "manifest.json") {
        data = `
        {
          "name": "plugin",
          "short_name": "plugin",
          "homepage_url": "",
          "description": "plugin-b for tests",
          "ubiquity:listeners": ["${ISSUE_COMMENT_CREATED}"],
          "commands": {
            "command": {
              "description": "description",
              "ubiquity:example": "${COMMAND_EXAMPLE}"
            }
          }
        }
        `;
      } else if (args.repo !== CONFIG_ORG_REPO) {
        data = `
        plugins:
          repo-3/plugin-3:
            with:
              setting1: false
          repo-1/plugin-1:
            with:
              setting2: true`;
      } else {
        data = `
        plugins:
          uses-1/plugin-1:
            with:
              settings1: 'enabled'
          repo-1/plugin-1:
            with:
              setting1: false
          repo-2/plugin-2:
            with:
              setting2: true`;
      }

      if (args.mediaType === undefined || args.mediaType?.format === "base64") {
        return {
          data: {
            content: btoa(data),
          },
        };
      }
      if (args.mediaType?.format === "raw") {
        return { data };
      }
    }

    const cfg = await getConfig({
      key: issueOpened,
      name: issueOpened,
      id: "",
      payload: {
        repository: {
          owner: { login: "ubiquity" },
          name: conversationRewardsRepo,
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
    } as unknown as GitHubContext);

    assertEquals(cfg.plugins["repo-3/plugin-3"], {
      runsOn: [ISSUE_COMMENT_CREATED],
      skipBotEvents: true,
      with: {
        setting1: false,
      },
    });
    assertEquals(cfg.plugins["repo-1/plugin-1"], {
      runsOn: [ISSUE_COMMENT_CREATED],
      skipBotEvents: true,
      with: {
        setting2: true,
      },
    });
    assertEquals(cfg.plugins["uses-1/plugin-1"], {
      runsOn: [ISSUE_COMMENT_CREATED],
      skipBotEvents: true,
      with: {
        settings1: "enabled",
      },
    });
    assertEquals(cfg.plugins["repo-2/plugin-2"], {
      runsOn: [ISSUE_COMMENT_CREATED],
      skipBotEvents: true,
      with: {
        setting2: true,
      },
    });
  } finally {
    fetchStub.restore();
  }
});

Deno.test("getConfig: resolves imports before merging repo configuration", async () => {
  const fetchStub = stubPluginAlphaManifest();
  try {
    const orgYaml = `
      imports:
        - ubiquity/shared-config
      plugins:
        https://plugin-a.internal:
          with:
            source: "org"
      `;
    const orgImportYaml = `
      plugins:
        https://plugin-a.internal:
          with:
            source: "org-import"
        https://plugin-b.internal:
          with:
            enabled: true
      `;
    const repoYaml = `
      imports:
        - ubiquity/repo-shared
      plugins:
        https://plugin-a.internal:
          with:
            source: "repo"
      `;
    const repoImportYaml = `
      plugins:
        https://plugin-c.internal:
          with:
            level: 2
      `;

    function getContent(args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
      let data: string;
      if (args.repo === CONFIG_ORG_REPO) {
        data = orgYaml;
      } else if (args.repo === conversationRewardsRepo) {
        data = repoYaml;
      } else if (args.repo === "shared-config") {
        data = orgImportYaml;
      } else if (args.repo === "repo-shared") {
        data = repoImportYaml;
      } else {
        throw new Error(NOT_FOUND_ERROR);
      }

      if (args.mediaType === undefined || args.mediaType?.format === "base64") {
        return {
          data: {
            content: btoa(data),
          },
        };
      }
      if (args.mediaType?.format === "raw") {
        return { data };
      }
    }

    const cfg = await getConfig({
      key: issueOpened,
      name: issueOpened,
      id: "",
      payload: {
        repository: {
          owner: { login: "ubiquity" },
          name: conversationRewardsRepo,
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
    } as unknown as GitHubContext);

    assertEquals(cfg.plugins["https://plugin-a.internal"]?.with, {
      source: "repo",
    });
    assertEquals(cfg.plugins["https://plugin-b.internal"]?.with, {
      enabled: true,
    });
    assertEquals(cfg.plugins["https://plugin-c.internal"]?.with, { level: 2 });
  } finally {
    fetchStub.restore();
  }
});

Deno.test("getConfig: hydrates empty runsOn from dist artifact manifest refs", async () => {
  const fetchStub = stubPluginAlphaManifest();
  const pluginKey = "ubiquity-os-marketplace/command-query@development";
  const orgYaml = `
    plugins:
      ${pluginKey}:
        with:
          allowPublicQuery: true
  `;
  const manifestJson = JSON.stringify({
    name: "command-query",
    short_name: pluginKey,
    homepage_url: "",
    description: "plugin manifest",
    "ubiquity:listeners": [ISSUE_COMMENT_CREATED],
    skipBotEvents: false,
    commands: {},
  });

  try {
    function getContent(args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
      if (args.path === "manifest.json") {
        if (args.ref === "dist/development") {
          return {
            data: {
              content: btoa(manifestJson),
            },
          };
        }
        const notFound = new Error(NOT_FOUND_ERROR) as Error & {
          status: number;
        };
        notFound.status = 404;
        throw notFound;
      }

      if (args.mediaType?.format === "raw") {
        if (args.repo === CONFIG_ORG_REPO && args.path === DEV_CONFIG_PATH) {
          return { data: orgYaml };
        }
        const notFound = new Error(NOT_FOUND_ERROR) as Error & {
          status: number;
        };
        notFound.status = 404;
        throw notFound;
      }

      const notFound = new Error(NOT_FOUND_ERROR) as Error & { status: number };
      notFound.status = 404;
      throw notFound;
    }

    const cfg = await getConfig({
      key: issueOpened,
      name: issueOpened,
      id: "",
      payload: {
        repository: {
          owner: { login: "ubiquity-os-marketplace" },
          name: "command-query",
        },
      } as unknown as GitHubContext<"issues.closed">["payload"],
      octokit: {
        rest: {
          repos: {
            getContent,
          },
        },
      },
      eventHandler: {
        environment: "development",
      } as GitHubEventHandler,
      logger,
    } as unknown as GitHubContext);

    assertEquals(cfg.plugins[pluginKey]?.runsOn, [ISSUE_COMMENT_CREATED]);
  } finally {
    fetchStub.restore();
  }
});
