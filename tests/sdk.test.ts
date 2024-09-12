import { server } from "./__mocks__/node";
import issueCommented from "./__mocks__/requests/issue-comment-post.json";
import { expect, describe, beforeAll, afterAll, afterEach, it, jest } from "@jest/globals";

import * as crypto from "crypto";
import { createPlugin } from "../src/sdk/server";
import { Hono } from "hono";
import { Context } from "../src/sdk/context";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: "spki",
    format: "pem",
  },
  privateKeyEncoding: {
    type: "pkcs8",
    format: "pem",
  },
});

let app: Hono;

beforeAll(async () => {
  app = await createPlugin(
    async (context: Context<{ shouldFail: boolean }>) => {
      if (context.config.shouldFail) {
        throw new Error("Failed");
      }
      return {
        success: true,
        event: context.eventName,
      };
    },
    { name: "test" },
    { kernelPublicKey: publicKey }
  );
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
  jest.resetModules();
  jest.restoreAllMocks();
});
afterAll(() => server.close());

describe("SDK worker tests", () => {
  it("Should serve manifest", async () => {
    const res = await app.request("/manifest.json", {
      method: "GET",
    });
    expect(res.status).toEqual(200);
    const result = await res.json();
    expect(result).toEqual({ name: "test" });
  });
  it("Should deny POST request with different path", async () => {
    const res = await app.request("/test", {
      method: "POST",
    });
    expect(res.status).toEqual(404);
  });
  it("Should deny POST request without content-type", async () => {
    const res = await app.request("/", {
      method: "POST",
    });
    expect(res.status).toEqual(400);
  });
  it("Should deny POST request with invalid signature", async () => {
    const data = {
      ...issueCommented,
      stateId: "stateId",
      authToken: process.env.GITHUB_TOKEN,
      settings: {
        shouldFail: false,
      },
      ref: "",
    };
    const signature = "invalid";
    const res = await app.request("/", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...data, signature }),
      method: "POST",
    });
    expect(res.status).toEqual(400);
  });
  it("Should handle thrown errors", async () => {
    const createComment = jest.fn();
    jest.mock("../src/sdk/octokit", () => ({
      customOctokit: class MockOctokit {
        constructor() {
          return {
            rest: {
              issues: {
                createComment,
              },
            },
          };
        }
      },
    }));

    const { createPlugin } = await import("../src/sdk/server");
    const app = await createPlugin(
      async (context: Context<{ shouldFail: boolean }>) => {
        if (context.config.shouldFail) {
          throw context.logger.error("test error");
        }
        return {
          success: true,
          event: context.eventName,
        };
      },
      { name: "test" },
      { kernelPublicKey: publicKey }
    );

    const data = {
      ...issueCommented,
      stateId: "stateId",
      authToken: process.env.GITHUB_TOKEN,
      settings: {
        shouldFail: true,
      },
      ref: "",
    };
    const sign = crypto.createSign("SHA256");
    sign.update(JSON.stringify(data));
    sign.end();
    const signature = sign.sign(privateKey, "base64");

    const res = await app.request("/", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...data, signature }),
      method: "POST",
    });
    expect(res.status).toEqual(500);
    expect(createComment).toHaveBeenCalledWith({
      issue_number: 5,
      owner: "ubiquibot",
      repo: "bot",
      body: `\`\`\`diff
! test error
\`\`\`
<!--
{
  "caller": "error"
}
-->`,
    });
  });
  it("Should accept correct request", async () => {
    const data = {
      ...issueCommented,
      stateId: "stateId",
      authToken: "test",
      settings: {
        shouldFail: false,
      },
      ref: "",
    };
    const sign = crypto.createSign("SHA256");
    sign.update(JSON.stringify(data));
    sign.end();
    const signature = sign.sign(privateKey, "base64");

    const res = await app.request("/", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...data, signature }),
      method: "POST",
    });
    expect(res.status).toEqual(200);
    const result = await res.json();
    expect(result).toEqual({ stateId: "stateId", output: { success: true, event: issueCommented.eventName } });
  });
});

describe("SDK actions tests", () => {
  it("Should accept correct request", async () => {
    jest.mock("@actions/github", () => ({
      context: {
        runId: "1",
        payload: {
          inputs: {
            stateId: "stateId",
            eventName: issueCommented.eventName,
            settings: "{}",
            eventPayload: JSON.stringify(issueCommented.eventPayload),
            authToken: "test",
            ref: "",
          },
        },
        repo: {
          owner: "ubiquity",
          repo: "ubiquibot-kernel",
        },
      },
    }));
    const setOutput = jest.fn();
    const setFailed = jest.fn();
    jest.mock("@actions/core", () => ({
      setOutput,
      setFailed,
    }));
    const createDispatchEvent = jest.fn();
    jest.mock("../src/sdk/octokit", () => ({
      customOctokit: class MockOctokit {
        constructor() {
          return {
            rest: {
              repos: {
                createDispatchEvent: createDispatchEvent,
              },
            },
          };
        }
      },
    }));
    const { createActionsPlugin } = await import("../src/sdk/actions");

    await createActionsPlugin(async (context: Context) => {
      return {
        event: context.eventName,
      };
    });
    expect(setOutput).toHaveBeenCalledWith("result", { event: issueCommented.eventName });
    expect(setFailed).not.toHaveBeenCalled();
    expect(createDispatchEvent).toHaveBeenCalledWith({
      event_type: "return_data_to_ubiquibot_kernel",
      owner: "ubiquity",
      repo: "ubiquibot-kernel",
      client_payload: {
        state_id: "stateId",
        output: JSON.stringify({ event: issueCommented.eventName }),
      },
    });
  });
});
