import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { config } from "dotenv";
import { http, HttpResponse } from "msw";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { getConfig } from "../src/github/utils/config";
import { app } from "../src/kernel"; // has to be imported after the mocks
import { server } from "./__mocks__/node";
import "./__mocks__/webhooks";

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

const eventHandler = {
  environment: "production",
} as GitHubEventHandler;

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
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => jest.fn());
    process.env = {
      ENVIRONMENT: "production",
      APP_WEBHOOK_SECRET: "",
      APP_ID: "",
      APP_PRIVATE_KEY: "",
      OPENAI_API_KEY: "token",
    };
    const res = await app.request("http://localhost:8080", {
      method: "POST",
    });
    expect(res.status).toEqual(500);
    expect(await res.json()).toEqual({ error: "Error: Invalid environment variables" });
    consoleSpy.mockReset();
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
        eventHandler: eventHandler,
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
        eventHandler: eventHandler,
      } as unknown as GitHubContext);
      expect(cfg).toBeTruthy();
      const pluginChain = cfg.plugins;
      expect(pluginChain.length).toBe(1);
      expect(pluginChain[0].uses.length).toBe(1);
      expect(pluginChain[0].uses[0].skipBotEvents).toBeTruthy();
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
                "ubiquity:example": "/command"
              }
            }
          }
          `;
        } else if (args.repo !== ".ubiquity-os") {
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
        eventHandler: eventHandler,
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
            skipBotEvents: true,
            with: {
              setting1: false,
            },
          },
        ],
      });
      expect(cfg.plugins.slice(1)).toEqual([
        {
          uses: [
            {
              plugin: {
                owner: "repo-1",
                repo: "plugin-1",
                ref: undefined,
                workflowId: "compute.yml",
              },
              skipBotEvents: true,
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
