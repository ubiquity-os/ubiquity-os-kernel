import { logger } from "../../logger/logger";
import { GitHubContext } from "../github-context";
import { GithubPlugin } from "../types/plugin-configuration";
import { getConfig } from "../utils/config";
import { getManifest } from "../utils/plugins";

async function parseCommandsFromManifest(context: GitHubContext<"issue_comment.created">, plugin: string | GithubPlugin) {
  const commands: string[] = [];
  const manifest = await getManifest(context, plugin);
  if (manifest?.commands) {
    for (const [name, command] of Object.entries(manifest.commands)) {
      commands.push(`| \`/${getContent(name)}\` | ${getContent(command.description)} | \`${getContent(command["ubiquity:example"])}\` |`);
    }
  }
  return commands;
}

export async function postHelpCommand(context: GitHubContext<"issue_comment.created">) {
  const comments = [
    "### Available Commands\n\n",
    "| Command | Description | Example |",
    "|---|---|---|",
    "| `/help` | List all available commands. | `/help` |",
  ];
  const commands: string[] = [];
  const configuration = await getConfig(context);
  for (const pluginElement of configuration.plugins) {
    const { plugin } = pluginElement.uses[0];
    commands.push(...(await parseCommandsFromManifest(context, plugin)));
  }
  if (!commands.length) {
    logger.warn("No commands found, will not post the help command message.");
  } else {
    await context.octokit.rest.issues.createComment({
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
