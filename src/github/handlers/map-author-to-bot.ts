import { GitHubContext } from "../github-context";
import { getConfig } from "../utils/config";
import { getManifest } from "../utils/plugins";
import { processCommand } from "./issue-comment-created";
import { CommandCall } from "../../types/command";
import { collectLinkedIssue } from "../utils/collect-linked-pulls";

export async function mapAuthorToBot(context: GitHubContext<"issue_comment.created">, taskAuthor: string) {
  if (!(await requestingHelpCheck(context, taskAuthor))) {
    return null;
  }

  try {
    const config = await getConfig(context);
    for (const plugin of config.plugins) {
      const manifest = await getManifest(context, plugin.uses[0].plugin);

      if (manifest && manifest.commands && Object.keys(manifest.commands)?.includes("ask")) {
        const question = `**Do not tag the author** in your response to this question unless you absolutely cannot help the user.\n\n${context.payload.comment.body}`;
        const cmdCall: CommandCall = {
          name: "ask",
          parameters: {
            question,
          },
        };

        await processCommand(context, { plugin: plugin.uses[0], manifest }, cmdCall);
      }
    }
  } catch (e) {
    console.error("Error in mapAuthorToBot", e);
  }
}

async function requestingHelpCheck(context: GitHubContext<"issue_comment.created">, author: string) {
  const llmResponse = await context.openAi.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: [
          {
            text: `
  ### Instructions:
  
  - Determine if the user is seeking help from the task creator ${author}.
  - All comments will pass through you, so be thorough and accurate in your response.
  - If the user is asking for help from ${author}, respond with the below JSON structure.
  
  ### JSON Structure:
  {
    isRequestingHelp: true
  }
  
  ### Examples:
  
  - "I'd like to work on this task but I'm confused about xyz. @0x4007 can you help me?"
  - "@gentlementlegen What does the spec mean by 'xyz'?"
  - "I'm not sure how to proceed with this task. @0x4007 can you provide some guidance?"
  `,
            type: "text",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            text: context.payload.comment.body,
            type: "text",
          },
        ],
      },
    ],
    temperature: 1,
    max_completion_tokens: 100,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "isRequestingHelp",
        description: "Whether the user is requesting help from the task creator",
        strict: true,
        schema: {
          type: "object",
          properties: {
            isRequestingHelp: {
              type: "boolean",
            },
          },
          required: ["isRequestingHelp"],
          additionalProperties: false,
        },
      },
    },
  });

  try {
    return JSON.parse(llmResponse.choices[0].message.content ?? "{}").isRequestingHelp;
  } catch (e) {
    console.error("Error in requestingHelpCheck", e);
  }
  return false;
}

export async function findTaskAuthor(context: GitHubContext<"issue_comment.created">) {
  // need to get the author of the task
  const issue = await context.octokit.rest.issues.get({
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    issue_number: context.payload.issue.number,
  });

  // if its a PR we want the author of the task, not the PR author

  if (!("pull_request" in issue.data)) {
    if (!issue.data.user) {
      console.log("No task author found for issue", {
        url: issue.data.html_url,
      });
      return null;
    }
    return issue.data.user?.login;
  }

  const task = await collectLinkedIssue(context);
  if (!task) {
    console.log("No task found for PR", {
      url: issue.data.html_url,
    });
    return null;
  }

  return task.author.login;
}

export async function preCheckForMappingAuthorToBot(context: GitHubContext<"issue_comment.created">, taskAuthor: string) {
  return context.payload.comment.body.startsWith(`@${taskAuthor}`);
}
