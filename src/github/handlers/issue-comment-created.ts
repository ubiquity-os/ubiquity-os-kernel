import { GitHubContext } from "../github-context";
import { getConfig } from "../utils/config";
import { GithubPlugin, isGithubPlugin } from "../types/plugin-configuration";

interface Command {
  command: string;
  description: string;
  example: string;
}

interface Manifest {
  name: string;
  description: string;
  commands: Command[];
}

export default async function issueCommentCreated(context: GitHubContext<"issue_comment.created">) {
  const body = context.payload.comment.body.trim();
  if (/^\/help$/.test(body)) {
    const comments = [
      "### Available Commands\n\n",
      "| Command | Description | Example |",
      "|---|---|---|",
      "| `/help` | List all available commands. | `/help` |",
    ];
    const commands: string[] = [];
    const configuration = await getConfig(context);
    for (const pluginArray of Object.values(configuration.plugins)) {
      for (const pluginElement of pluginArray) {
        const { plugin } = pluginElement.uses[0];
        const manifest = await (isGithubPlugin(plugin) ? fetchActionManifest(context, plugin) : fetchWorkerManifest(plugin));
        if (manifest?.commands) {
          for (const command of manifest.commands) {
            commands.push(`| \`${getContent(command.command)}\` | ${getContent(command.description)} | \`${getContent(command.example)}\` |`);
          }
        }
      }
    }
    await context.octokit.issues.createComment({
      body: comments.concat(commands.sort()).join("\n"),
      issue_number: context.payload.issue.number,
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
    });
  }
}

/**
 * Ensures that passed content does not break MD display within the table.
 */
function getContent(content: string | undefined) {
  return content ? content.replace("|", "\\|") : "-";
}

async function fetchActionManifest(context: GitHubContext<"issue_comment.created">, { owner, repo }: GithubPlugin): Promise<Manifest | null> {
  try {
    const { data } = await context.octokit.repos.getContent({
      owner,
      repo,
      path: "manifest.json",
    });
    if ("content" in data) {
      const content = Buffer.from(data.content, "base64").toString();
      return JSON.parse(content);
    }
  } catch (e) {
    console.warn(`Could not find a manifest for ${owner}/${repo}`);
  }
  return null;
}

async function fetchWorkerManifest(url: string): Promise<Manifest | null> {
  const manifestUrl = `${url}/manifest.json`;
  try {
    const result = await fetch(manifestUrl);
    return await result.json();
  } catch (e) {
    console.warn(`Could not find a manifest for ${manifestUrl}`);
  }
  return null;
}
