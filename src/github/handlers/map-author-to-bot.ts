import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { GitHubContext } from "../github-context";
import { getConfig } from "../utils/config";
import { getManifest } from "../utils/plugins";
import { processCommand } from "./issue-comment-created";
import { CommandCall } from "../../types/command";

export async function mapAuthorToBot(context: GitHubContext<"issue_comment.created">, taskAuthor: string) {
  const helpCheck = await requestingHelpCheck(context, taskAuthor);

  try {
    if (helpCheck && JSON.parse(helpCheck).isRequestingHelp) {
      const config = await getConfig(context);

      // how do we handle this better?
      const isLocal = process.env.NODE_ENV === "local" || true;
      const askPlugin = config.plugins.find((plgn) => {
        const plugin = String(plgn.uses[0].plugin);
        if (isLocal) {
          return plugin.includes("localhost") || plugin.includes("ngrok");
        }

        return !plugin.includes("localhost") && !plugin.includes("ngrok") && plugin.includes("command-ask");
      })?.uses[0];

      if (askPlugin) {
        const manifest = await getManifest(context, askPlugin.plugin) as Manifest;
        if (!manifest || !manifest.commands) {
          console.log("No manifest found for ask plugin");
          return;
        }

        const cmdCall: CommandCall = {
          name: manifest.name,
          parameters: {
            ...manifest.commands.ask.parameters,
            required: Object.keys(manifest.commands.ask.parameters?.properties),
            additionalProperties: false,
          },
        };

        await processCommand(context, { plugin: askPlugin, manifest }, cmdCall)
      } else {
        console.log("No ask plugin found in config");
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
      type: "text",
    },
  });

  if (llmResponse.choices.length === 0) {
    return;
  }

  return llmResponse.choices[0].message.content;
}

export async function findTaskAuthor(context: GitHubContext<"issue_comment.created">) {
  // need to get the author of the task
  const issue = await context.octokit.rest.issues.get({
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    issue_number: context.payload.issue.number,
  });

  const isPr = "pull_request" in issue.data;

  // if its a PR we want the author of the task, not the PR author

  if (!isPr) {
    if (!issue.data.user) {
      console.log("No task author found for issue", {
        url: issue.data.html_url,
      });
      return;
    }
    return issue.data.user.login;
  }

  const pr = await context.octokit.rest.pulls.get({
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    pull_number: context.payload.issue.number,
  });

  if (!pr.data.body) {
    console.log("No body found for PR, could not map Author to UbiquityOS", {
      url: pr.data.html_url,
    });
    return;
  }

  // we need to track the task which this PR is going to close
  const hashMatch = pr.data.body.match(/#(\d+)/);
  const urlMatch = pr.data.body.match(/https:\/\/github.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);

  if (!hashMatch && !urlMatch) {
    console.log("No task reference found in PR body, could not map Author to UbiquityOS", {
      url: pr.data.html_url,
    });
    return;
  }

  let taskNumber;
  let taskFetchCtx: null | { owner: string; repo: string; issueNumber: number } = null;

  if (hashMatch) {
    taskNumber = parseInt(hashMatch[1]);
    if (!taskNumber) {
      console.log("No task number found in PR body, could not map Author to UbiquityOS", {
        url: pr.data.html_url,
      });
      return;
    }
    taskFetchCtx = {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issueNumber: taskNumber,
    };
  } else if (urlMatch) {
    // this could be cross repo, cross org, etc
    taskNumber = parseInt(urlMatch[3]);
    if (!taskNumber) {
      console.log("No task number found in PR body, could not map Author to UbiquityOS", {
        url: pr.data.html_url,
      });
      return;
    }

    taskFetchCtx = {
      owner: urlMatch[1],
      repo: urlMatch[2],
      issueNumber: taskNumber,
    };
  } else {
    console.log("No task reference found in PR body, could not map Author to UbiquityOS", {
      url: pr.data.html_url,
    });
    return;
  }

  const task = await context.octokit.rest.issues.get({
    owner: taskFetchCtx.owner,
    repo: taskFetchCtx.repo,
    issue_number: taskFetchCtx.issueNumber,
  });

  if (!task.data.user) {
    console.log("No task author found for issue", {
      url: task.data.html_url,
    });
    return;
  }

  return task.data.user.login;
}

export async function preCheckForMappingAuthorToBot(
  context: GitHubContext<"issue_comment.created">,
  taskAuthor: string
) {
  if (!context.payload.comment.body.startsWith(`@${taskAuthor}`)) {
    return false;
  }

  return true;
}