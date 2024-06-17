import { afterAll, afterEach, beforeAll, describe, it, mock } from "bun:test";
import { config } from "dotenv";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";
import issueCommentCreated from "../src/github/handlers/issue-comment-created";
import { server } from "./__mocks__/node";
import { WebhooksMocked } from "./__mocks__/webhooks";

void mock.module("@octokit/webhooks", () => ({
  Webhooks: WebhooksMocked,
}));

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

describe("Event related tests", () => {
  it("Should post the help menu when /help command is invoked", async () => {
    await issueCommentCreated({
      id: "",
      key: "issue_comment.created",
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
      payload: {
        repository: {
          owner: { login: "ubiquity" },
          name: "ubiquibot-kernel",
        },
        comment: {
          body: "/help",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
    } as unknown as GitHubContext);
  });
});
