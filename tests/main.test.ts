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
          short_name: "plugin",
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
                    https://plugin-a.internal: {}
                  `,
                };
              },
            },
          },
        },
        eventHandler: eventHandler,
        logger,
      } as unknown as GitHubContext);
      expect(cfg).toBeTruthy();
      expect(cfg.plugins).toEqual({
        "https://plugin-a.internal": {
          runsOn: [],
          skipBotEvents: true,
          with: {},
        },
      });
    });
    it("Should merge organization and repository configuration", async () => {
      function getContent(args: RestEndpointMethodTypes["repos"]["getContent"]["parameters"]) {
        let data: string;
        if (args.path === "manifest.json") {
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
