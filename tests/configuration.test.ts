import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { config } from "dotenv";
import { server } from "./__mocks__/node";
import { WebhooksMocked } from "./__mocks__/webhooks";
import { getConfig } from "../src/github/utils/config";
import { GitHubContext } from "../src/github/github-context";
import { GitHubEventHandler } from "../src/github/github-event-handler";

config({ path: ".dev.vars" });

void mock.module("@octokit/webhooks", () => ({
  Webhooks: WebhooksMocked,
}));

const issueOpened = "issues.opened";

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

describe("Configuration tests", () => {
  it("Should properly parse the Action path if a branch and workflow are specified", async () => {
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
plugins:
  - uses:
    - plugin: ubiquity/user-activity-watcher:compute.yml@pull/1
      with:
        settings1: 'enabled'`,
              };
            },
          },
        },
      },
      eventHandler: {} as GitHubEventHandler,
    } as unknown as GitHubContext);
    expect(cfg.plugins[0]).toEqual({
      uses: [
        {
          plugin: {
            owner: "ubiquity",
            repo: "user-activity-watcher",
            workflowId: "compute.yml",
            ref: "pull/1",
          },
          runsOn: [],
          with: {
            settings1: "enabled",
          },
        },
      ],
      skipBotEvents: true,
    });
  });
});
