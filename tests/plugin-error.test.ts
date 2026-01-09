import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { Octokit } from "@octokit/rest";
import crypto from "crypto";
import { http, HttpResponse } from "msw";
import { server } from "./__mocks__/node";

jest.mock("@octokit/plugin-paginate-rest", () => ({}));
jest.mock("@octokit/plugin-rest-endpoint-methods", () => ({}));
jest.mock("@octokit/plugin-retry", () => ({}));
jest.mock("@octokit/plugin-throttling", () => ({}));
jest.mock("@octokit/auth-app", () => ({
  createAppAuth: jest.fn(() => () => jest.fn(() => ({ token: "1234" }))),
}));

const PLUGIN_INPUT_MODULE = "../src/github/types/plugin";
const PLUGIN_ERROR_EVENT = "kernel.plugin_error";
const WORKFLOW_DISPATCH_MODULE = "../src/github/utils/workflow-dispatch";
const TEST_OWNER = "test-user";
const TEST_REPO = "test-repo";
const TEST_REPO_FULL_NAME = `${TEST_OWNER}/${TEST_REPO}`;
const TEST_SECRET = "test-secret";
const TEST_DELIVERY_ID = "mocked_delivery_id";
const TEST_SERVER_URL = "http://localhost:8080";
const TEST_EVENT_NAME = "issues";
const TEST_TRIGGER_EVENT = "issues.opened";

jest.mock(PLUGIN_INPUT_MODULE, () => {
  const originalModule = jest.requireActual<typeof import("../src/github/types/plugin")>(PLUGIN_INPUT_MODULE);

  return {
    ...originalModule,
    PluginInput: class extends originalModule.PluginInput {
      async getInputs() {
        return {
          stateId: this.stateId,
          eventName: this.eventName,
          eventPayload: JSON.stringify(this.eventPayload),
          settings: JSON.stringify(this.settings),
          authToken: this.authToken,
          ref: this.ref,
          signature: "",
          command: JSON.stringify(this.command),
        };
      }
    },
  };
});

function calculateSignature(payload: string, secret: string) {
  return `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

beforeAll(() => {
  server.listen();
});

afterEach(() => {
  server.resetHandlers();
  jest.resetModules();
});

afterAll(() => {
  server.close();
});

describe(PLUGIN_ERROR_EVENT, () => {
  const failingPluginUrl = "https://failing-plugin.internal";
  const hotfixPluginUrl = "https://daemon-hotfix.internal";
  const orgConfigUrl = `https://api.github.com/repos/${TEST_OWNER}/.ubiquity-os/contents/.github%2F.ubiquity-os.config.yml`;
  const repoConfigUrl = `https://api.github.com/repos/${TEST_OWNER}/${TEST_REPO}/contents/.github%2F.ubiquity-os.config.yml`;

  beforeEach(() => {
    const yamlContent = ["plugins:", `  ${failingPluginUrl}: {}`, `  ${hotfixPluginUrl}: {}`, ""].join("\n");

    function respondWithYaml(req: { request: Request }) {
      const acceptHeader = req.request.headers.get("accept");
      if (acceptHeader === "application/vnd.github.v3.raw") {
        return HttpResponse.text(yamlContent);
      }
      return HttpResponse.json({
        type: "file",
        encoding: "base64",
        size: yamlContent.length,
        name: ".ubiquity-os.config.yml",
        path: ".github/.ubiquity-os.config.yml",
        content: Buffer.from(yamlContent).toString("base64"),
        sha: "mock",
        url: orgConfigUrl,
        git_url: "",
        html_url: "",
        download_url: "",
      });
    }

    server.use(
      http.get(`${failingPluginUrl}/manifest.json`, () =>
        HttpResponse.json({
          name: "failing-plugin",
          short_name: "failing-plugin",
          "ubiquity:listeners": ["issues.opened"],
          skipBotEvents: false,
        })
      ),
      http.get(`${hotfixPluginUrl}/manifest.json`, () =>
        HttpResponse.json({
          name: "daemon-hotfix",
          short_name: "daemon-hotfix",
          "ubiquity:listeners": [PLUGIN_ERROR_EVENT],
          skipBotEvents: false,
        })
      ),
      http.get(orgConfigUrl, respondWithYaml),
      http.get(repoConfigUrl, respondWithYaml)
    );
  });

  it(`dispatches ${PLUGIN_ERROR_EVENT} to subscribed plugins when a plugin dispatch fails`, async () => {
    jest.resetModules();
    const dispatchWorker = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("HTTP 502: bad gateway");
      })
      .mockImplementationOnce(() => Promise.resolve("ok"));

    jest.doMock("../src/github/github-client", () => ({
      customOctokit: jest.fn().mockReturnValue(new Octokit()),
    }));

    jest.doMock(WORKFLOW_DISPATCH_MODULE, () => ({
      ...(jest.requireActual(WORKFLOW_DISPATCH_MODULE) as object),
      dispatchWorker,
      dispatchWorkflow: jest.fn(),
    }));

    const payload = {
      action: "opened",
      installation: {
        id: 1,
      },
      sender: {
        type: "User",
        login: TEST_OWNER,
      },
      issue: {
        number: 123,
      },
      repository: {
        id: 123456,
        name: TEST_REPO,
        full_name: TEST_REPO_FULL_NAME,
        owner: {
          login: TEST_OWNER,
          id: 654321,
        },
      },
    };

    const secret = TEST_SECRET;
    const payloadString = JSON.stringify(payload);
    const signature = calculateSignature(payloadString, secret);

    const originalEnv = { ...process.env };
    try {
      process.env = {
        ENVIRONMENT: "production",
        APP_WEBHOOK_SECRET: secret,
        APP_ID: "1",
        APP_PRIVATE_KEY: "1234",
      };

      const app = (await import("../src/kernel")).app;
      const res = await app.request(TEST_SERVER_URL, {
        method: "POST",
        headers: {
          "x-github-event": TEST_EVENT_NAME,
          "x-hub-signature-256": signature,
          "x-github-delivery": TEST_DELIVERY_ID,
          "content-type": "application/json",
        },
        body: payloadString,
      });

      expect(res).toBeTruthy();
      expect(dispatchWorker).toHaveBeenCalledTimes(2);

      const [, hotfixInputs] = dispatchWorker.mock.calls[1];
      expect(hotfixInputs.eventName).toBe(PLUGIN_ERROR_EVENT);
      const pluginError = JSON.parse(String(hotfixInputs.eventPayload));
      expect(pluginError.event).toBe(PLUGIN_ERROR_EVENT);
      expect(pluginError.plugin.type).toBe("http");
      expect(pluginError.plugin.id).toBe(failingPluginUrl);
      expect(pluginError.trigger.githubEvent).toBe(TEST_TRIGGER_EVENT);
      expect(pluginError.trigger.repo).toBe(TEST_REPO_FULL_NAME);
    } finally {
      process.env = originalEnv;
    }
  });

  it(`dispatches ${PLUGIN_ERROR_EVENT} when a kernel handler throws`, async () => {
    jest.resetModules();
    const dispatchWorker = jest.fn().mockResolvedValue("ok");
    const getPluginsForEvent = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("Kernel handler blew up");
      })
      .mockResolvedValueOnce([
        {
          key: hotfixPluginUrl,
          target: hotfixPluginUrl,
          settings: {},
        },
      ]);

    jest.doMock("../src/github/github-client", () => ({
      customOctokit: jest.fn().mockReturnValue(new Octokit()),
    }));

    jest.doMock(WORKFLOW_DISPATCH_MODULE, () => ({
      ...(jest.requireActual(WORKFLOW_DISPATCH_MODULE) as object),
      dispatchWorker,
      dispatchWorkflow: jest.fn(),
    }));

    jest.doMock("../src/github/utils/plugins", () => ({
      ...(jest.requireActual("../src/github/utils/plugins") as object),
      getPluginsForEvent,
    }));

    const payload = {
      action: "opened",
      installation: {
        id: 1,
      },
      sender: {
        type: "User",
        login: TEST_OWNER,
      },
      issue: {
        number: 123,
      },
      repository: {
        id: 123456,
        name: TEST_REPO,
        full_name: TEST_REPO_FULL_NAME,
        owner: {
          login: TEST_OWNER,
          id: 654321,
        },
      },
    };

    const secret = TEST_SECRET;
    const payloadString = JSON.stringify(payload);
    const signature = calculateSignature(payloadString, secret);

    const originalEnv = { ...process.env };
    try {
      process.env = {
        ENVIRONMENT: "production",
        APP_WEBHOOK_SECRET: secret,
        APP_ID: "1",
        APP_PRIVATE_KEY: "1234",
      };

      const app = (await import("../src/kernel")).app;
      const res = await app.request(TEST_SERVER_URL, {
        method: "POST",
        headers: {
          "x-github-event": TEST_EVENT_NAME,
          "x-hub-signature-256": signature,
          "x-github-delivery": TEST_DELIVERY_ID,
          "content-type": "application/json",
        },
        body: payloadString,
      });

      expect(res).toBeTruthy();
      expect(dispatchWorker).toHaveBeenCalledTimes(1);

      const [, hotfixInputs] = dispatchWorker.mock.calls[0];
      expect(hotfixInputs.eventName).toBe(PLUGIN_ERROR_EVENT);
      const pluginError = JSON.parse(String(hotfixInputs.eventPayload));
      expect(pluginError.error.category).toBe("kernel");
      expect(pluginError.plugin.type).toBe("kernel");
      expect(pluginError.plugin.id).toBe("ubiquity-os/ubiquity-os-kernel");
      expect(pluginError.trigger.githubEvent).toBe(TEST_TRIGGER_EVENT);
      expect(pluginError.trigger.repo).toBe(TEST_REPO_FULL_NAME);
    } finally {
      process.env = originalEnv;
    }
  });
});
