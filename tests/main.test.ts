import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { config } from "dotenv";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { getConfig } from "../src/github/utils/config";
import { server } from "./__mocks__/node";
import "./__mocks__/webhooks";
import worker from "../src/worker"; // has to be imported after the mocks
import { http, HttpResponse } from "msw";

jest.mock("@octokit/plugin-paginate-rest", () => ({}));
jest.mock("@octokit/plugin-rest-endpoint-methods", () => ({}));
jest.mock("@octokit/plugin-retry", () => ({}));
jest.mock("@octokit/plugin-throttling", () => ({}));
jest.mock("@octokit/auth-app", () => ({}));
jest.mock("@octokit/core", () => ({
  Octokit: {
    plugin: jest.fn(() => ({ defaults: jest.fn() })),
  },
}));

const issueOpened = "issues.opened";

config({ path: ".dev.vars" });

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

describe("Worker tests", () => {
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
  it("Should fail on missing env variables", async () => {
    const req = new Request("http://localhost:8080");
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => jest.fn());
    const res = await worker.fetch(req, {
      WEBHOOK_SECRET: "",
      APP_ID: "",
      APP_PRIVATE_KEY: "",
      PLUGIN_CHAIN_STATE: {} as KVNamespace,
    });
    expect(res.status).toEqual(500);
    consoleSpy.mockReset();
  });

  it("Should start a worker", async () => {
    const req = new Request("http://localhost:8080", {
      headers: {
        "x-github-event": issueOpened,
        "x-github-delivery": "1",
        "x-hub-signature-256": "123456",
      },
    });
    const res = await worker.fetch(req, {
      WEBHOOK_SECRET: "webhook-secret",
      APP_ID: "app-id",
      APP_PRIVATE_KEY: "private-key",
      PLUGIN_CHAIN_STATE: {} as KVNamespace,
    });
    expect(await res.text()).toEqual("ok\n");
    expect(res.status).toEqual(200);
  });

  describe("Configuration tests", () => {
    it("Should generate a default configuration when no repo is defined", async () => {
      const cfg = await getConfig({
        key: issueOpened,
        name: issueOpened,
        id: "",
        payload: {
          repository: "",
        },
        octokit: {},
        eventHandler: {} as GitHubEventHandler,
      } as unknown as GitHubContext);
      expect(cfg).toBeTruthy();
    });
    it("Should generate a default configuration when the target repo does not contain one", async () => {
      const cfg = await getConfig({
        key: issueOpened,
        name: issueOpened,
        id: "",
        payload: {
          repository: {
            owner: { login: "ubiquity" },
            name: "ubiquibot-kernel",
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
        eventHandler: {} as GitHubEventHandler,
      } as unknown as GitHubContext);
      expect(cfg).toBeTruthy();
    });
    it("Should fill the config with defaults", async () => {
      const cfg = await getConfig({
        key: issueOpened,
        name: issueOpened,
        id: "",
        payload: {
          repository: {
            owner: { login: "ubiquity" },
            name: "ubiquibot-kernel",
          },
        } as unknown as GitHubContext<"issues.closed">["payload"],
        octokit: {
          rest: {
            repos: {
              getContent() {
                return {
                  data: `
                  plugins:
                    - name: "Run on comment created"
                      uses:
                        - id: plugin-A
                          plugin: https://plugin-a.internal
                  `,
                };
              },
            },
          },
        },
        eventHandler: {} as GitHubEventHandler,
      } as unknown as GitHubContext);
      expect(cfg).toBeTruthy();
      const pluginChain = cfg.plugins;
      expect(pluginChain.length).toBe(1);
      expect(pluginChain[0].uses.length).toBe(1);
      expect(pluginChain[0].skipBotEvents).toBeTruthy();
      expect(pluginChain[0].uses[0].id).toBe("plugin-A");
      expect(pluginChain[0].uses[0].plugin).toBe("https://plugin-a.internal");
      expect(pluginChain[0].uses[0].with).toEqual({});
    });
    it("Should merge organization and repository configuration", async () => {
      const workflowId = "compute.yml";
      function getContent(args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
        let data: string;
        if (args.path === "manifest.json") {
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
        } else if (args.repo !== "ubiquibot-config") {
          data = `
          plugins:
            - uses:
              - plugin: repo-3/plugin-3
                with:
                  setting1: false
            - uses:
              - plugin: repo-1/plugin-1
                with:
                  setting2: true`;
        } else {
          data = `
          plugins:
            - uses:
              - plugin: uses-1/plugin-1
                with:
                  settings1: 'enabled'
            - uses:
              - plugin: repo-1/plugin-1
                with:
                  setting1: false
            - uses:
              - plugin: repo-2/plugin-2
                with:
                  setting2: true`;
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
          repository: {
            owner: { login: "ubiquity" },
            name: "conversation-rewards",
          },
        } as unknown as GitHubContext<"issues.closed">["payload"],
        octokit: {
          rest: {
            repos: {
              getContent,
            },
          },
        },
        eventHandler: {} as GitHubEventHandler,
      } as unknown as GitHubContext);
      expect(cfg.plugins[0]).toEqual({
        uses: [
          {
            plugin: {
              owner: "repo-3",
              repo: "plugin-3",
              ref: undefined,
              workflowId,
            },
            runsOn: [],
            with: {
              setting1: false,
            },
          },
        ],
        skipBotEvents: true,
      });
      expect(cfg.plugins.slice(1)).toEqual([
        {
          skipBotEvents: true,
          uses: [
            {
              plugin: {
                owner: "repo-1",
                repo: "plugin-1",
                ref: undefined,
                workflowId: "compute.yml",
              },
              runsOn: [],
              with: {
                setting2: true,
              },
            },
          ],
        },
      ]);
    });
  });
});
