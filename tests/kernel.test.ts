import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { EmitterWebhookEvent } from "@octokit/webhooks";
import { config } from "dotenv";
import { http, HttpResponse } from "msw";
import OpenAI from "openai";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import { DEV_CONFIG_FULL_PATH } from "../src/github/utils/config";
import { logger } from "../src/logger/logger";
import helloWorldManifest from "./__mocks__/manifest.json";
import { server } from "./__mocks__/node";
import "./__mocks__/webhooks";

jest.mock("@octokit/plugin-paginate-rest", () => ({}));
jest.mock("@octokit/plugin-rest-endpoint-methods", () => ({}));
jest.mock("@octokit/plugin-retry", () => ({}));
jest.mock("@octokit/plugin-throttling", () => ({}));
jest.mock("@octokit/auth-app", () => ({}));

config({ path: ".env" });

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
  jest.clearAllMocks();
  jest.resetAllMocks();
  jest.resetModules();
});
afterAll(() => {
  server.close();
});

// Mock OpenAI
const mockOpenAi = {
  chat: {
    completions: {
      create: jest.fn(),
    },
  },
} as unknown as OpenAI;

// Mock GitHubEventHandler
const TEST_ENVIRONMENT = "development";
const TEST_ORG = "0x4007";
const TEST_REPO = "ubiquity-os-sandbox";
const TEST_HELLO_WORLD_URL = "http://127.0.0.1:9090";
const MOCK_TOKEN = "mock-token";
const mockEventHandler = {
  environment: TEST_ENVIRONMENT,
  getToken: jest.fn().mockResolvedValue(MOCK_TOKEN),
  signPayload: jest.fn().mockResolvedValue("mock-signature"),
  logger: logger,
} as unknown as GitHubEventHandler;

// Mock octokit responses
const mockOctokit = {
  rest: {
    repos: {
      getContent: jest.fn(),
    },
  },
};

// Constants
const TEST_APP_ID = "12345";
const TEST_PRIVATE_KEY = "test-private-key";
const TEST_WEBHOOK_SECRET = "test-secret";
const TEST_MODEL_NAME = "test-model";
const TEST_MODEL = TEST_MODEL_NAME;

// Helper to create fake event
function createFakeEvent(org: string, repo: string, commentBody: string): EmitterWebhookEvent {
  return {
    id: "test-event-id",
    name: "issue_comment",
    payload: {
      action: "created",
      repository: {
        owner: { login: org },
        name: repo,
        full_name: `${org}/${repo}`,
      },
      issue: {
        number: 1,
        html_url: `https://github.com/${org}/${repo}/issues/1`,
      },
      comment: {
        body: commentBody,
        html_url: `https://github.com/${org}/${repo}/issues/1#issuecomment-123`,
        user: {
          login: "testuser",
          type: "User",
        },
      },
      installation: {
        id: 12345,
      },
      sender: {
        login: "testuser",
        type: "User",
      },
    },
  } as EmitterWebhookEvent;
}

// Mock config response
function mockConfigResponse() {
  return {
    data: `
plugins:
  ${TEST_HELLO_WORLD_URL}: {}
`,
  };
}

describe("Kernel Event Processing Tests", () => {
  beforeEach(() => {
    (mockEventHandler.getToken as jest.Mock).mockResolvedValue(MOCK_TOKEN);
    (mockEventHandler.signPayload as jest.Mock).mockResolvedValue("mock-signature");

    (mockOctokit.rest.repos.getContent as jest.Mock).mockImplementation(async ({ path, mediaType }: { path: string; mediaType?: { format?: string } }) => {
      if (path === DEV_CONFIG_FULL_PATH && mediaType?.format === "raw") {
        return { data: mockConfigResponse().data, headers: {} };
      }
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    server.use(http.get(`${TEST_HELLO_WORLD_URL}/manifest.json`, () => HttpResponse.json(helloWorldManifest)));

    // Mock OpenAI for command routing
    (mockOpenAi.chat.completions.create as jest.Mock).mockResolvedValue({
      choices: [
        {
          message: {
            tool_calls: [
              {
                type: "function",
                function: {
                  name: "hello",
                  arguments: "{}",
                },
              },
            ],
          },
        },
      ],
    });
  });

  it("Should process /hello comment and dispatch to hello-world-plugin", async () => {
    // Mock dispatch functions
    const mockDispatchWorkflow = jest.fn().mockResolvedValue(undefined);
    const mockDispatchWorker = jest.fn().mockResolvedValue(undefined);

    jest.doMock("../src/github/utils/workflow-dispatch", () => ({
      getDefaultBranch: jest.fn().mockResolvedValue("main"),
      dispatchWorkflow: mockDispatchWorkflow,
      dispatchWorker: mockDispatchWorker,
    }));

    // Create fake event
    const fakeEvent = createFakeEvent(TEST_ORG, TEST_REPO, "/hello");

    // Create event handler instance
    const eventHandler = new GitHubEventHandler({
      environment: TEST_ENVIRONMENT,
      webhookSecret: TEST_WEBHOOK_SECRET,
      appId: TEST_APP_ID,
      privateKey: TEST_PRIVATE_KEY,
      llmClient: mockOpenAi,
      llm: TEST_MODEL,
    });
    jest.spyOn(eventHandler, "getToken").mockResolvedValue(MOCK_TOKEN);

    // Bind handlers
    const { bindHandlers } = await import("../src/github/handlers/index");
    bindHandlers(eventHandler);

    // Mock the transformEvent to return our mocked context
    jest.spyOn(eventHandler, "transformEvent").mockReturnValue({
      id: "test-context-id",
      key: "issue_comment.created",
      octokit: mockOctokit,
      openAi: mockOpenAi,
      eventHandler: mockEventHandler,
      payload: fakeEvent.payload,
      logger: logger,
    } as unknown as ReturnType<typeof eventHandler.transformEvent>);

    // Trigger event processing
    await eventHandler.webhooks.receive(fakeEvent);

    // Slash commands should bypass LLM routing
    expect(mockOpenAi.chat.completions.create).not.toHaveBeenCalled();

    // Verify dispatches
    expect(mockDispatchWorker).toHaveBeenCalledWith(
      TEST_HELLO_WORLD_URL,
      expect.objectContaining({
        command: expect.stringContaining('"name":"hello"'),
      })
    );

    // Verify no workflow dispatches for this simple case
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("Should handle config loading and plugin resolution", async () => {
    const fakeEvent = createFakeEvent(TEST_ORG, TEST_REPO, "/help");

    const eventHandler = new GitHubEventHandler({
      environment: TEST_ENVIRONMENT,
      webhookSecret: TEST_WEBHOOK_SECRET,
      appId: TEST_APP_ID,
      privateKey: TEST_PRIVATE_KEY,
      llmClient: mockOpenAi,
      llm: TEST_MODEL,
    });
    jest.spyOn(eventHandler, "getToken").mockResolvedValue(MOCK_TOKEN);

    // Mock transformEvent
    jest.spyOn(eventHandler, "transformEvent").mockReturnValue({
      id: "test-context-id",
      key: "issue_comment.created",
      octokit: mockOctokit,
      openAi: mockOpenAi,
      eventHandler: mockEventHandler,
      payload: fakeEvent.payload,
      logger: logger,
    } as unknown as ReturnType<typeof eventHandler.transformEvent>);

    // Mock issues.createComment for help response
    const mockCreateComment = jest.fn().mockResolvedValue(undefined);
    mockOctokit.rest.issues = { createComment: mockCreateComment };

    // Bind handlers and process
    const { bindHandlers } = await import("../src/github/handlers/index");
    bindHandlers(eventHandler);

    await eventHandler.webhooks.receive(fakeEvent);

    // Verify help menu was posted
    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("| Command | Description | Example |"),
        issue_number: 1,
        owner: TEST_ORG,
        repo: TEST_REPO,
      })
    );
  });
});
