import { getConfig } from "../utils/config";
import { GithubPlugin } from "../types/plugin-configuration";
import { GitHubContext } from "../github-context";
import { getManifest } from "../utils/plugins";
import { Context } from "@ubiquity-os/plugin-sdk";

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
    console.warn("No commands found, will not post the help command message.");
  } else {
    await context.commentHandler.postComment(context as unknown as Context, context.logger.ok(comments.concat(commands.sort()).join("\n")));
  }
}

/**
 * Ensures that passed content does not break MD display within the table.
 */
function getContent(content: string | undefined) {
  return content ? content.replace("|", "\\|") : "-";
}
