import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
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
    const issues = {
      createComment(params?: RestEndpointMethodTypes["issues"]["createComment"]["parameters"]) {
        return params;
      },
    };
    const spy = spyOn(issues, "createComment");
    await issueCommentCreated({
      id: "",
      key: "issue_comment.created",
      octokit: {
        issues,
        rest: {
          repos: {
            getContent() {
              return {
                data: `
                  plugins:
                    issue_comment.created:
                      - name: "Run on comment created"
                        description: "Plugin A"
                        example: /command [foo | bar]
                        command: /command
                        uses:
                          - id: plugin-A
                            plugin: https://plugin-a.internal
                  `,
              };
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
        issue: { number: 1 },
        comment: {
          body: "/help",
        },
      } as unknown as GitHubContext<"issue_comment.created">["payload"],
    } as unknown as GitHubContext);
    expect(spy).toBeCalledTimes(1);
    expect(spy.mock.calls).toEqual([
      [
        {
          body:
            "### Available Commands\n\n\n| Command | Description | Example |\n|---|---|---|\n| `/help` | List" +
            " all available commands. | `/help` |\n| `/command` | Plugin A | `/command [foo \\| bar]` |",
          issue_number: 1,
          owner: "ubiquity",
          repo: "ubiquibot-kernel",
        },
      ],
    ]);
  });
});
