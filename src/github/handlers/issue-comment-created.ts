import { GitHubContext } from "../github-context";
import { getConfig } from "../utils/config";

export default async function issueCommentCreated(context: GitHubContext<"issue_comment.created">) {
  const body = context.payload.comment.body.trim();
  if (/^\/help$/.test(body)) {
    const comments = [
      "### Available Commands\n\n",
      "| Command | Description | Example |",
      "|---|---|---|",
      "| `/help` | List all available commands. | `/help` |",
    ];
    const configuration = await getConfig(context);
    for (const pluginArray of Object.values(configuration.plugins)) {
      for (const plugin of pluginArray) {
        // Only show plugins that have commands available for the user
        if (plugin.command) {
          comments.push(`| \`${getContent(plugin.command)}\` | ${getContent(plugin.description)} | \`${getContent(plugin.example)}\` |`);
        }
      }
    }
    await context.octokit.issues.createComment({
      body: comments.join("\n"),
      issue_number: context.payload.issue.number,
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
    });
  }
}

function getContent(content: string | undefined) {
  return content || "-";
}
