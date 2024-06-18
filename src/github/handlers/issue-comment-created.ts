import { GitHubContext } from "../github-context";
import { getConfig } from "../utils/config";

export default async function issueCommentCreated(context: GitHubContext<"issue_comment.created">) {
  const body = context.payload.comment.body.trim();
  if (/^\/help$/.test(body)) {
    const comments = ["---", "| name | description | command | example |", "---"];
    const configuration = await getConfig(context);
    for (const pluginArray of Object.values(configuration.plugins)) {
      for (const plugin of pluginArray) {
        comments.push(`| ${plugin.name} | ${plugin.description} | \`${plugin.command}\` | \`${plugin.example}\` |`);
      }
    }
    await context.octokit.issues.createComment({
      body: comments.join("\n"),
      issue_number: 0,
      owner: "",
      repo: "",
    });
  }
}
