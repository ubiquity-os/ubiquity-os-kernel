import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { http, HttpResponse } from "msw";
import { server } from "./__mocks__/node";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { logger } from "../src/logger/logger";

jest.mock("@octokit/plugin-paginate-rest", () => ({}));
jest.mock("@octokit/plugin-rest-endpoint-methods", () => ({}));
jest.mock("@octokit/plugin-retry", () => ({}));
jest.mock("@octokit/plugin-throttling", () => ({}));
jest.mock("@octokit/auth-app", () => ({
  createAppAuth: jest.fn(() => () => jest.fn(() => "1234")),
}));
jest.mock("../src/github/handlers/router-decision", () => ({
  getRouterDecision: jest.fn().mockResolvedValue({
    raw: JSON.stringify({ action: "ignore" }),
    decision: { action: "ignore" },
  }),
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

const issueCommentCreatedEvent = "issue_comment.created";
const FOO_COMMAND = "foo";
const PLUGIN_NAME = "plugin";

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
          name: PLUGIN_NAME,
          short_name: "plugin-a",
          "ubiquity:listeners": [issueCommentCreatedEvent],
          commands: {
            [FOO_COMMAND]: {
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
      http.get("https://plugin-b.internal/manifest.json", () =>
        HttpResponse.json({
          name: PLUGIN_NAME,
          short_name: "plugin-b",
          "ubiquity:listeners": [issueCommentCreatedEvent],
          commands: {
            [FOO_COMMAND]: {
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
        const yamlContent = `plugins:\n  https://plugin-a.internal:\n    with: {}\n  https://plugin-b.internal:\n    with: {}`;
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

  it("should continue dispatching plugins if dispatch throws an error", async () => {
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
      action: "created",
      installation: {
        id: 1,
      },
      sender: {
        type: "User",
      },
      comment: {
        id: 101,
        body: "please do foo",
        user: {
          login: "test-user",
          type: "User",
        },
      },
      issue: {
        user: {
          login: "test-user",
        },
        number: 1,
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
    const fakeEvent = {
      id: "test-event-id",
      name: "issue_comment",
      payload,
    } as const;

    const eventHandler = new GitHubEventHandler({
      environment: "production",
      webhookSecret: "1234",
      appId: "1",
      privateKey: "1234",
      llm: "test-model",
    });
    jest.spyOn(eventHandler, "getToken").mockResolvedValue("mock-token");

    const { bindHandlers } = await import("../src/github/handlers/index");
    bindHandlers(eventHandler);

    const yamlContent = `plugins:\n  https://plugin-a.internal:\n    with: {}\n  https://plugin-b.internal:\n    with: {}`;
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockResolvedValue({ data: yamlContent, headers: {} }),
        },
        issues: {
          listComments: jest.fn().mockResolvedValue({ data: [] }),
        },
      },
    };

    jest.spyOn(eventHandler, "transformEvent").mockReturnValue({
      id: "test-context-id",
      key: issueCommentCreatedEvent,
      octokit: mockOctokit,
      eventHandler,
      payload: fakeEvent.payload,
      logger,
    } as unknown as ReturnType<typeof eventHandler.transformEvent>);

    await eventHandler.webhooks.receive(fakeEvent);

    // Event dispatch should continue after a failure.
    expect(dispatchWorker).toHaveBeenCalledTimes(2);

    dispatchWorker.mockReset();
  });
});
