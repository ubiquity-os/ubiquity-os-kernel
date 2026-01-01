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

describe("kernel.plugin_error", () => {
  beforeEach(() => {
    const yamlContent = [
      "plugins:",
      "  https://failing-plugin.internal: {}",
      "  https://daemon-hotfix.internal: {}",
      "",
    ].join("\n");

    const respondWithYaml = (req: { request: Request }) => {
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
        url: "https://api.github.com/repos/test-user/.ubiquity-os/contents/.github%2F.ubiquity-os.config.yml",
        git_url: "",
        html_url: "",
        download_url: "",
      });
    };

    server.use(
      http.get("https://failing-plugin.internal/manifest.json", () =>
        HttpResponse.json({
          name: "failing-plugin",
          short_name: "failing-plugin",
          "ubiquity:listeners": ["issues.opened"],
          skipBotEvents: false,
        })
      ),
      http.get("https://daemon-hotfix.internal/manifest.json", () =>
        HttpResponse.json({
          name: "daemon-hotfix",
          short_name: "daemon-hotfix",
          "ubiquity:listeners": ["kernel.plugin_error"],
          skipBotEvents: false,
        })
      ),
      http.get("https://api.github.com/repos/test-user/.ubiquity-os/contents/.github%2F.ubiquity-os.config.yml", respondWithYaml),
      http.get("https://api.github.com/repos/test-user/test-repo/contents/.github%2F.ubiquity-os.config.yml", respondWithYaml)
    );
  });

  it("dispatches kernel.plugin_error to subscribed plugins when a plugin dispatch fails", async () => {
    jest.mock("../src/github/github-client", () => {
      return {
        customOctokit: jest.fn().mockReturnValue(new Octokit()),
      };
    });

    const dispatchWorker = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("HTTP 502: bad gateway");
      })
      .mockImplementationOnce(() => Promise.resolve("ok"));

    jest.mock("../src/github/utils/workflow-dispatch", () => ({
      ...(jest.requireActual("../src/github/utils/workflow-dispatch") as object),
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
        login: "test-user",
      },
      issue: {
        number: 123,
      },
      repository: {
        id: 123456,
        name: "test-repo",
        full_name: "test-user/test-repo",
        owner: {
          login: "test-user",
          id: 654321,
        },
      },
    };

    const secret = "test-secret";
    const payloadString = JSON.stringify(payload);
    const signature = calculateSignature(payloadString, secret);

    const originalEnv = { ...process.env };
    process.env = {
      ENVIRONMENT: "production",
      APP_WEBHOOK_SECRET: secret,
      APP_ID: "1",
      APP_PRIVATE_KEY: "1234",
      OPENROUTER_API_KEY: "token",
      OPENROUTER_MODEL: "deepseek/deepseek-chat-v3-0324:free",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    };

    const app = (await import("../src/kernel")).app;
    const res = await app.request("http://localhost:8080", {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": signature,
        "x-github-delivery": "mocked_delivery_id",
        "content-type": "application/json",
      },
      body: payloadString,
    });

    expect(res).toBeTruthy();
    expect(dispatchWorker).toHaveBeenCalledTimes(2);

    const [, hotfixInputs] = dispatchWorker.mock.calls[1];
    expect(hotfixInputs.eventName).toBe("kernel.plugin_error");
    const pluginError = JSON.parse(String(hotfixInputs.eventPayload));
    expect(pluginError.event).toBe("kernel.plugin_error");
    expect(pluginError.plugin.type).toBe("http");
    expect(pluginError.plugin.id).toBe("https://failing-plugin.internal");
    expect(pluginError.trigger.githubEvent).toBe("issues.opened");
    expect(pluginError.trigger.repo).toBe("test-user/test-repo");

    process.env = originalEnv;
  });
});

