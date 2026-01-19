import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { stubFetch } from "./test-utils/fetch-stub.ts";

import type { GitHubContext } from "../src/github/github-context.ts";
import { postHelpCommand } from "../src/github/handlers/help-command.ts";
import { CONFIG_FULL_PATH } from "../src/github/utils/config.ts";

const EXPECTED_COMMAND_RESPONSE_MARKER = '\n\n<!-- "commentKind": "command-response" -->';

Deno.test("/help: posts comment with commands + footer", async () => {
  const originalGitRevision = Deno.env.get("GIT_REVISION");
  Deno.env.set("GIT_REVISION", "deadbeef");

  const fetchStub = stubFetch({
    "https://plugin-a.internal/manifest.json": new Response(
      JSON.stringify({
        name: "plugin-A",
        short_name: "plugin-a",
        homepage_url: "",
        description: "plugin-a for tests",
        "ubiquity:listeners": ["issue_comment.created"],
        commands: {
          foo: { description: "foo command", "ubiquity:example": "/foo bar" },
        },
      }),
      { headers: { "content-type": "application/json" } }
    ),
    "https://plugin-a.internal//manifest.json": new Response(
      JSON.stringify({
        name: "plugin-A",
        short_name: "plugin-a",
        homepage_url: "",
        description: "plugin-a for tests",
        "ubiquity:listeners": ["issue_comment.created"],
        commands: {
          foo: { description: "foo command", "ubiquity:example": "/foo bar" },
        },
      }),
      { headers: { "content-type": "application/json" } }
    ),
  });

  const createCommentCalls: Array<{ body: string }> = [];

  const octokit = {
    rest: {
      issues: {
        createComment: async ({ body }: { body: string }) => {
          createCommentCalls.push({ body });
          return {};
        },
      },
      repos: {
        getContent: async ({ path }: { owner: string; repo: string; path: string }) => {
          if (path === CONFIG_FULL_PATH) {
            return {
              data: `
              plugins:
                https://plugin-a.internal:
                  with: {}
                ubiquity-os/plugin-b:
                  with: {}
              `,
            };
          }

          if (path === "manifest.json") {
            return {
              data: {
                content: btoa(
                  JSON.stringify({
                    name: "plugin-B",
                    short_name: "plugin-b",
                    homepage_url: "",
                    description: "plugin-b for tests",
                    "ubiquity:listeners": ["issue_comment.created"],
                    commands: {
                      hello: {
                        description: "hello command",
                        "ubiquity:example": "/hello @pavlovcik",
                      },
                    },
                  })
                ),
              },
            };
          }

          return { data: null };
        },
      },
    },
  };

  const context = {
    id: "",
    key: "issue_comment.created",
    name: "issue_comment.created",
    payload: {
      repository: { owner: { login: "ubiquity" }, name: "ubiquity-os-kernel" },
      issue: { number: 1 },
      installation: { id: 1 },
      comment: { id: 101, node_id: "test-node-id", body: "/help", user: { login: "test-user", type: "User" } },
    } as never,
    octokit: octokit as never,
    eventHandler: { environment: "production" } as never,
    logger: { trace: () => {}, info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, github: () => {} } as never,
    llm: "",
    configurationHandler: {} as never,
  } as GitHubContext<"issue_comment.created">;

  try {
    await postHelpCommand(context);
  } finally {
    fetchStub.restore();
    if (originalGitRevision === undefined) {
      Deno.env.delete("GIT_REVISION");
    } else {
      Deno.env.set("GIT_REVISION", originalGitRevision);
    }
  }

  assertEquals(createCommentCalls.length, 1);
  const body = createCommentCalls[0].body;
  assertStringIncludes(body, "| Command | Description | Example |");
  assertStringIncludes(body, "| `/help` | List all available commands. | `/help` |");
  assertStringIncludes(body, "`/foo`");
  assertStringIncludes(body, "`/hello`");
  assertStringIncludes(body, "###### UbiquityOS Production [deadbee](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/deadbee)");
  assertStringIncludes(body, EXPECTED_COMMAND_RESPONSE_MARKER);

  const helpIndex = body.indexOf("| `/help` |");
  const fooIndex = body.indexOf("`/foo`");
  const helloIndex = body.indexOf("`/hello`");
  assert(helpIndex > -1);
  assert(fooIndex > -1);
  assert(helloIndex > -1);
  assert(helpIndex < fooIndex);
  assert(helpIndex < helloIndex);
});
