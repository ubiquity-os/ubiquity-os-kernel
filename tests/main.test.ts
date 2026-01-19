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

const eventHandler = {
  environment: "production",
} as GitHubEventHandler;

function stubPluginAManifest() {
  return stubFetch({
    "https://plugin-a.internal/manifest.json": new Response(
      JSON.stringify({
        name: "plugin",
        short_name: "plugin",
        homepage_url: "",
        description: "plugin-a for tests",
        "ubiquity:listeners": ["issue_comment.created"],
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
        "ubiquity:listeners": ["issue_comment.created"],
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
  const fetchStub = stubPluginAManifest();
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
  const fetchStub = stubPluginAManifest();
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
  const fetchStub = stubPluginAManifest();
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
        runsOn: ["issue_comment.created"],
        skipBotEvents: true,
        with: {},
      },
    });
  } finally {
    fetchStub.restore();
  }
});

Deno.test("getConfig: merges organization and repository configuration", async () => {
  const fetchStub = stubPluginAManifest();
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
          "ubiquity:listeners": ["issue_comment.created"],
          "commands": {
            "command": {
              "description": "description",
              "ubiquity:example": "/command"
            }
          }
        }
        `;
      } else if (args.repo !== ".ubiquity-os") {
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
      runsOn: ["issue_comment.created"],
      skipBotEvents: true,
      with: {
        setting1: false,
      },
    });
    assertEquals(cfg.plugins["repo-1/plugin-1"], {
      runsOn: ["issue_comment.created"],
      skipBotEvents: true,
      with: {
        setting2: true,
      },
    });
    assertEquals(cfg.plugins["uses-1/plugin-1"], {
      runsOn: ["issue_comment.created"],
      skipBotEvents: true,
      with: {
        settings1: "enabled",
      },
    });
    assertEquals(cfg.plugins["repo-2/plugin-2"], {
      runsOn: ["issue_comment.created"],
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
  const fetchStub = stubPluginAManifest();
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
      if (args.repo === ".ubiquity-os") {
        data = orgYaml;
      } else if (args.repo === conversationRewardsRepo) {
        data = repoYaml;
      } else if (args.repo === "shared-config") {
        data = orgImportYaml;
      } else if (args.repo === "repo-shared") {
        data = repoImportYaml;
      } else {
        throw new Error("Not Found");
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

    assertEquals(cfg.plugins["https://plugin-a.internal"]?.with, { source: "repo" });
    assertEquals(cfg.plugins["https://plugin-b.internal"]?.with, { enabled: true });
    assertEquals(cfg.plugins["https://plugin-c.internal"]?.with, { level: 2 });
  } finally {
    fetchStub.restore();
  }
});
