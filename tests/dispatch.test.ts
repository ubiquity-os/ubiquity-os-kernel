import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import crypto from "crypto";
import { server } from "./__mocks__/node";
import { http, HttpResponse } from "msw";
import { Octokit } from "@octokit/rest";

jest.mock("@octokit/plugin-paginate-rest", () => ({}));
jest.mock("@octokit/plugin-rest-endpoint-methods", () => ({}));
jest.mock("@octokit/plugin-retry", () => ({}));
jest.mock("@octokit/plugin-throttling", () => ({}));
jest.mock("@octokit/auth-app", () => ({
  createAppAuth: jest.fn(() => () => jest.fn(() => "1234")),
}));

jest.mock("../src/github/utils/kv-store", () => ({
  CloudflareKv: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    put: jest.fn(),
  })),
  EmptyStore: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    put: jest.fn(),
  })),
}));

jest.mock("../src/github/types/plugin", () => {
  const originalModule: typeof import("../src/github/types/plugin") = jest.requireActual("../src/github/types/plugin");

  return {
    ...originalModule,
    PluginInput: class extends originalModule.PluginInput {
      async getWorkerInputs() {
        return {
          stateId: this.stateId,
          eventName: this.eventName,
          eventPayload: this.eventPayload,
          settings: this.settings,
          authToken: this.authToken,
          ref: this.ref,
          signature: "",
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
});
afterAll(() => {
  server.close();
});

describe("handleEvent", () => {
  beforeEach(() => {
    server.use(
      http.get("https://plugin-a.internal/manifest.json", () =>
        HttpResponse.json({
          name: "plugin",
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
        })
      ),
      http.get("https://api.github.com/repos/test-user/.ubiquity-os/contents/.github%2F.ubiquity-os.config.yml", (req) => {
        const acceptHeader = req.request.headers.get("accept");
        const yamlContent = `plugins:\n  - uses:\n    - plugin: "https://plugin-a.internal"\n  - uses:\n    - plugin: "https://plugin-a.internal"`;
        if (acceptHeader === "application/vnd.github.v3.raw") {
          return HttpResponse.text(yamlContent);
        } else {
          return HttpResponse.json({
            type: "file",
            encoding: "base64",
            size: 62,
            name: ".ubiquity-os.config.yml",
            path: ".github/.ubiquity-os.config.yml",
            content: Buffer.from(yamlContent).toString("base64"),
            sha: "3ffce0fe837a21b1237acd38f7b1c3d2f7d73656",
            url: "https://api.github.com/repos/test-user/.ubiquity-os/contents/.github%2F.ubiquity-os.config.yml",
            git_url: "https://api.github.com/repos/test-user/.ubiquity-os/git/blobs/3ffce0fe837a21b1237acd38f7b1c3d2f7d73656",
            html_url: "https://github.com/test-user/.ubiquity-os/blob/main/.github/.ubiquity-os.config.yml",
            download_url: "https://raw.githubusercontent.com/test-user/.ubiquity-os/main/.github/.ubiquity-os.config.yml",
          });
        }
      })
    );
  });

  it("should not stop the plugin chain if dispatch throws an error", async () => {
    jest.mock("../src/github/github-client", () => {
      return {
        customOctokit: jest.fn().mockReturnValue(new Octokit()),
      };
    });
    const dispatchWorker = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("Test induced first call failure");
      })
      .mockImplementationOnce(() => Promise.resolve("success"));
    jest.mock("../src/github/utils/workflow-dispatch", () => ({
      ...(jest.requireActual("../src/github/utils/workflow-dispatch") as object),
      dispatchWorker: dispatchWorker,
    }));
    const payload = {
      installation: {
        id: 1,
      },
      sender: {
        type: "User",
      },
      comment: {
        body: "/foo",
      },
      repository: {
        id: 123456,
        name: ".ubiquity-os",
        full_name: "test-user/.ubiquity-os",
        owner: {
          login: "test-user",
          id: 654321,
        },
      },
    };
    const secret = "1234";
    const payloadString = JSON.stringify(payload);
    const signature = calculateSignature(payloadString, secret);

    const req = new Request("http://localhost:8080", {
      method: "POST",
      headers: {
        "x-github-event": "issue_comment.created",
        "x-hub-signature-256": signature,
        "x-github-delivery": "mocked_delivery_id",
        "content-type": "application/json",
      },
      body: payloadString,
    });

    const worker = (await import("../src/worker")).default;
    const res = await worker.fetch(req, {
      ENVIRONMENT: "production",
      APP_WEBHOOK_SECRET: secret,
      APP_ID: "1",
      APP_PRIVATE_KEY: "1234",
      PLUGIN_CHAIN_STATE: {} as KVNamespace,
    });

    expect(res).toBeTruthy();
    // 2 calls means the execution didn't break
    expect(dispatchWorker).toHaveBeenCalledTimes(2);
    dispatchWorker.mockReset();
  });
});
