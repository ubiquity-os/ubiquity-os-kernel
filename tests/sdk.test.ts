import { server } from "./__mocks__/node";
import issueCommented from "./__mocks__/requests/issue-comment-post.json";
import { expect, describe, beforeAll, afterAll, afterEach, it, jest } from "@jest/globals";

import * as crypto from "crypto";
import { createPlugin } from "../src/sdk/server";
import { Context } from "../src/sdk/context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { EmptyStore } from "../src/github/utils/kv-store";
import { PluginChainState, PluginInput } from "../src/github/types/plugin";
import { EmitterWebhookEventName } from "@octokit/webhooks";

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

const issueCommentedEvent = {
  eventName: issueCommented.eventName as EmitterWebhookEventName,
  eventPayload: issueCommented.eventPayload,
};

const sdkOctokitImportPath = "../src/sdk/octokit";
const githubActionImportPath = "@actions/github";
const githubCoreImportPath = "@actions/core";

const eventHandler = new GitHubEventHandler({
  environment: "production",
  webhookSecret: "test",
  appId: "1",
  privateKey: privateKey,
  pluginChainState: new EmptyStore<PluginChainState>(),
});

const app = createPlugin(
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

beforeAll(async () => {
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
    const inputs = new PluginInput(eventHandler, "stateId", issueCommentedEvent.eventName, issueCommentedEvent.eventPayload, { shouldFail: false }, "test", "");

    const res = await app.request("/", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...(await inputs.getWorkerInputs()), signature: "invalid_signature" }),
      method: "POST",
    });
    expect(res.status).toEqual(400);
  });
  it("Should handle thrown errors", async () => {
    const createComment = jest.fn();
    jest.mock(sdkOctokitImportPath, () => ({
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
    const app = createPlugin(
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

    const inputs = new PluginInput(eventHandler, "stateId", issueCommentedEvent.eventName, issueCommentedEvent.eventPayload, { shouldFail: true }, "test", "");

    const res = await app.request("/", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(await inputs.getWorkerInputs()),
      method: "POST",
    });
    expect(res.status).toEqual(500);
    expect(createComment).toHaveBeenCalledWith({
      issue_number: 5,
      owner: "ubiquity-os",
      repo: "bot",
      body: `\`\`\`diff
! test error
\`\`\`

<!-- Ubiquity - undefined -  - undefined
{
  "caller": "error"
}
-->
`,
    });
  });
  it("Should accept correct request", async () => {
    const inputs = new PluginInput(eventHandler, "stateId", issueCommentedEvent.eventName, issueCommentedEvent.eventPayload, { shouldFail: false }, "test", "");

    const res = await app.request("/", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(await inputs.getWorkerInputs()),
      method: "POST",
    });
    expect(res.status).toEqual(200);
    const result = await res.json();
    expect(result).toEqual({ stateId: "stateId", output: { success: true, event: issueCommented.eventName } });
  });
});

describe("SDK actions tests", () => {
  process.env.PLUGIN_GITHUB_TOKEN = "token";
  const repo = {
    owner: "ubiquity",
    repo: "ubiquity-os-kernel",
  };

  it("Should accept correct request", async () => {
    const inputs = new PluginInput(eventHandler, "stateId", issueCommentedEvent.eventName, issueCommentedEvent.eventPayload, {}, "test_token", "");
    const githubInputs = await inputs.getWorkflowInputs();
    jest.mock(githubActionImportPath, () => ({
      context: {
        runId: "1",
        payload: {
          inputs: githubInputs,
        },
        repo: repo,
      },
    }));
    const setOutput = jest.fn();
    const setFailed = jest.fn();
    jest.mock(githubCoreImportPath, () => ({
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

    await createActionsPlugin(
      async (context: Context) => {
        return {
          event: context.eventName,
        };
      },
      {
        kernelPublicKey: publicKey,
      }
    );
    expect(setFailed).not.toHaveBeenCalled();
    expect(setOutput).toHaveBeenCalledWith("result", { event: issueCommented.eventName });
    expect(createDispatchEvent).toHaveBeenCalledWith({
      event_type: "return-data-to-ubiquity-os-kernel",
      owner: repo.owner,
      repo: repo.repo,
      client_payload: {
        state_id: "stateId",
        output: JSON.stringify({ event: issueCommented.eventName }),
      },
    });
  });
  it("Should deny invalid signature", async () => {
    const inputs = new PluginInput(eventHandler, "stateId", issueCommentedEvent.eventName, issueCommentedEvent.eventPayload, {}, "test_token", "");
    const githubInputs = await inputs.getWorkflowInputs();

    jest.mock("@actions/github", () => ({
      context: {
        runId: "1",
        payload: {
          inputs: {
            ...githubInputs,
            signature: "invalid_signature",
          },
        },
        repo: repo,
      },
    }));
    const setOutput = jest.fn();
    const setFailed = jest.fn();
    jest.mock(githubCoreImportPath, () => ({
      setOutput,
      setFailed,
    }));
    const { createActionsPlugin } = await import("../src/sdk/actions");

    await createActionsPlugin(
      async (context: Context) => {
        return {
          event: context.eventName,
        };
      },
      {
        kernelPublicKey: publicKey,
      }
    );
    expect(setFailed).toHaveBeenCalledWith("Error: Invalid signature");
    expect(setOutput).not.toHaveBeenCalled();
  });
  it("Should accept inputs in different order", async () => {
    const inputs = new PluginInput(eventHandler, "stateId", issueCommentedEvent.eventName, issueCommentedEvent.eventPayload, {}, "test_token", "");
    const githubInputs = await inputs.getWorkflowInputs();

    jest.mock(githubActionImportPath, () => ({
      context: {
        runId: "1",
        payload: {
          inputs: {
            // different order
            signature: githubInputs.signature,
            eventName: githubInputs.eventName,
            settings: githubInputs.settings,
            ref: githubInputs.ref,
            authToken: githubInputs.authToken,
            stateId: githubInputs.stateId,
            eventPayload: githubInputs.eventPayload,
          },
        },
        repo: repo,
      },
    }));
    const setOutput = jest.fn();
    const setFailed = jest.fn();
    jest.mock(githubCoreImportPath, () => ({
      setOutput,
      setFailed,
    }));
    const createDispatchEventFn = jest.fn();
    jest.mock(sdkOctokitImportPath, () => ({
      customOctokit: class MockOctokit {
        constructor() {
          return {
            rest: {
              repos: {
                createDispatchEvent: createDispatchEventFn,
              },
            },
          };
        }
      },
    }));
    const { createActionsPlugin } = await import("../src/sdk/actions");

    await createActionsPlugin(
      async (context: Context) => {
        return {
          event: context.eventName,
        };
      },
      {
        kernelPublicKey: publicKey,
      }
    );
    expect(setFailed).not.toHaveBeenCalled();
    expect(setOutput).toHaveBeenCalledWith("result", { event: issueCommentedEvent.eventName });
    expect(createDispatchEventFn).toHaveBeenCalledWith({
      event_type: "return-data-to-ubiquity-os-kernel",
      owner: repo.owner,
      repo: repo.repo,
      client_payload: {
        state_id: "stateId",
        output: JSON.stringify({ event: issueCommentedEvent.eventName }),
      },
    });
  });
});
