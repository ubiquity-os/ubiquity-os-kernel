/* eslint-disable @typescript-eslint/naming-convention */

// @ts-expect-error package name is correct, TypeScript doesn't recognize it
import { afterAll, afterEach, beforeAll, describe, expect, it, jest, mock, spyOn } from "bun:test";
mock.module("@octokit/webhooks", () => ({
  Webhooks: WebhooksMocked,
}));

const issueOpened = "issues.opened";

class WebhooksMocked {
  constructor(_: unknown) {}
  verifyAndReceive(_: unknown) {
    return Promise.resolve();
  }
  onAny(_: unknown) {}
  on(_: unknown) {}
  onError(_: unknown) {}
  removeListener(_: unknown, __: unknown) {}
  sign(_: unknown) {}
  verify(_: unknown, __: unknown) {}
  receive(_: unknown) {}
}

import { config } from "dotenv";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { getConfig } from "../src/github/utils/config";
import worker from "../src/worker";
import { server } from "./__mocks__/node";

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
  it("Should fail on missing env variables", async () => {
    const req = new Request("http://localhost:8080");
    const consoleSpy = spyOn(console, "error").mockImplementation(() => jest.fn());
    const res = await worker.fetch(req, {
      WEBHOOK_SECRET: "",
      APP_ID: "",
      PRIVATE_KEY: "",
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
      APP_ID: process.env.APP_ID,
      PRIVATE_KEY: "private-key",
      PLUGIN_CHAIN_STATE: {} as KVNamespace,
    });
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
    it("Should merge the configuration when found", async () => {
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
              getContent() {
                return {
                  data: `
incentives:
  enabled: false`,
                };
              },
            },
          },
        },
        eventHandler: {} as GitHubEventHandler,
      } as unknown as GitHubContext);
      expect(cfg).toBeTruthy();
      expect(cfg.incentives.enabled).toBeFalse();
    });
  });
});
