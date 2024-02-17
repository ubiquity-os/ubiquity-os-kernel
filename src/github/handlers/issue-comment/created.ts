import { GitHubContext } from "../../github-context";
import { UbiquiBotConfig, getUbiquiBotConfig } from "../../ubiquibot-config";
import { generateHelpMenu } from "./help/help";

export const userCommands: IssueCommentCreatedCommand[] = [{ id: "/help", description: "List all available commands.", example: "/help", handler: generateHelpMenu }];
// fetch the ubiquibot-config.yml from the current repository, from the current organization, then merge (priority being the current repository.)
// ubiquibot-config.yml is always meant to live at .github/ubiquibot-config.yml
export async function issueCommentCreated(event: GitHubContext<"issue_comment.created">) {
  const configuration = await getUbiquiBotConfig(event);
  const command = commentParser(event.payload.comment.body);
  if (!command) {
    return;
  }
  const commandHandler = userCommands.find((cmd) => cmd.id === command);
  if (!commandHandler) {
    return;
  } else {
    const result = await commandHandler.handler(event, configuration, event.payload.comment.body);
    if (typeof result === "string") {
      // Extract issue number and repository details from the event payload
      const issueNumber = event.payload.issue.number;
      const repo = event.payload.repository.name;
      const owner = event.payload.repository.owner.login;

      // Create a new comment on the issue
      await event.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body: result,
      });
    }
    return result;
  }
}

// Parses the comment body and figure out the command name a user wants
function commentParser(body: string): null | string {
  const userCommandIds = userCommands.map((cmd) => cmd.id);
  const regex = new RegExp(`^(${userCommandIds.join("|")})\\b`); // Regex pattern to match any command at the beginning of the body
  const matches = regex.exec(body);
  if (matches) {
    const command = matches[0] as string;
    if (userCommandIds.includes(command)) {
      return command;
    }
  }

  return null;
}

type IssueCommentCreatedCommand = {
  id: string;
  description: string;
  example: string;
  handler: IssueCommentCreatedHandler;
};

type IssueCommentCreatedHandler = (context: GitHubContext<"issue_comment.created">, configuration: UbiquiBotConfig, body: string) => Promise<string | null>;
