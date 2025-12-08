import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { config } from "dotenv";
import { http, HttpResponse } from "msw";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { getConfig } from "../src/github/utils/config";
import { app } from "../src/kernel";
import { logger } from "../src/logger/logger"; // has to be imported after the mocks
import { server } from "./__mocks__/node";
import "./__mocks__/webhooks";
import { createConfigurationHandler } from "./test-utils/configuration-handler";

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
const fooDescription = "foo command";
const barDescription = "bar command";
const fooExample = "/foo bar";
const barExample = "/bar foo";

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
      http.get("https://api.github.com/repos/ubiquity-os/plugin-a/contents/manifest.json", () =>
        HttpResponse.json({
          content: Buffer.from(
            JSON.stringify({
              name: "plugin",
              homepage_url: "https://plugin-a.internal",
              commands: {
                foo: {
                  description: fooDescription,
                  "ubiquity:example": fooExample,
                },
                bar: {
                  description: barDescription,
                  "ubiquity:example": barExample,
                },
              },
            })
          ).toString("base64"),
          encoding: "base64",
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
      OPENROUTER_API_KEY: "token",
      OPENROUTER_MODEL: "deepseek/deepseek-chat-v3-0324:free",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    };
    const res = await app.request("http://localhost:8080", {
      method: "POST",
    });
    expect(res.status).toEqual(500);
    expect(await res.json()).toEqual({ error: "Error: Unable to decode value as it does not match the expected schema" });
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
        logger,
      } as unknown as GitHubContext);
      expect(cfg).toBeTruthy();
    });
    it("Should generate a default configuration when the target repo does not contain one", async () => {
      const configurationHandler = createConfigurationHandler({ configuration: { plugins: {} } });
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
        configurationHandler,
        logger,
      } as unknown as GitHubContext);
      expect(cfg).toBeTruthy();
    });
    it("Should fill the config with defaults", async () => {
      const configurationHandler = createConfigurationHandler({
        configuration: {
          plugins: {
            "ubiquity-os/plugin-a": { with: {} },
          },
        },
        manifests: {
          "plugin-a": {
            name: "plugin",
            commands: {
              foo: {
                description: fooDescription,
                "ubiquity:example": "/foo",
              },
            },
          },
        },
      });
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
              getContent(params?: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
                if (params?.path === "manifest.json") {
                  return {
                    data: {
                      content: Buffer.from(
                        JSON.stringify({
                          name: "plugin",
                          commands: {
                            foo: {
                              description: fooDescription,
                              "ubiquity:example": "/foo",
                            },
                          },
                        })
                      ).toString("base64"),
                    },
                  };
                }
                return {
                  data: `
                  plugins:
                    ubiquity-os/plugin-a: {}
                  `,
                };
              },
            },
          },
        },
        eventHandler: eventHandler,
        configurationHandler,
        logger,
      } as unknown as GitHubContext);
      expect(cfg).toBeTruthy();
      expect(cfg.plugins).toEqual({
        "ubiquity-os/plugin-a": {
          runsOn: [],
          skipBotEvents: true,
          with: {},
        },
      });
    });
    it("Should merge organization and repository configuration", async () => {
      const configurationHandler = createConfigurationHandler({
        configuration: {
          plugins: {
            "repo-3/plugin-3": {
              with: {
                setting1: false,
              },
            },
            "repo-1/plugin-1": {
              with: {
                setting2: true,
              },
            },
            "uses-1/plugin-1": {
              with: {
                settings1: "enabled",
              },
            },
            "repo-2/plugin-2": {
              with: {
                setting2: true,
              },
            },
          },
        },
        manifests: {
          "plugin-3": {
            name: "plugin",
            commands: {
              command: {
                description: "description",
                "ubiquity:example": "/command",
              },
            },
          },
          "plugin-1": {
            name: "plugin",
            commands: {
              command: {
                description: "description",
                "ubiquity:example": "/command",
              },
            },
          },
          "plugin-2": {
            name: "plugin",
            commands: {
              command: {
                description: "description",
                "ubiquity:example": "/command",
              },
            },
          },
        },
      });
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
              getContent: jest.fn(),
            },
          },
        },
        eventHandler: eventHandler,
        configurationHandler,
        logger,
      } as unknown as GitHubContext);
      expect(cfg.plugins).toMatchObject({
        "repo-3/plugin-3": {
          runsOn: [],
          skipBotEvents: true,
          with: {
            setting1: false,
          },
        },
        "repo-1/plugin-1": {
          runsOn: [],
          skipBotEvents: true,
          with: {
            setting2: true,
          },
        },
        "uses-1/plugin-1": {
          runsOn: [],
          skipBotEvents: true,
          with: {
            settings1: "enabled",
          },
        },
        "repo-2/plugin-2": {
          runsOn: [],
          skipBotEvents: true,
          with: {
            setting2: true,
          },
        },
      });
    });
  });
});
