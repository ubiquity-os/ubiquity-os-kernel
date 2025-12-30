import { GitHubContext } from "../github-context";
import { GithubPlugin, parsePluginIdentifier } from "../types/plugin-configuration";
import { getConfig } from "../utils/config";
import { getManifest } from "../utils/plugins";

type CommandRow = {
  key: string;
  row: string;
};

async function parseCommandsFromManifest(context: GitHubContext<"issue_comment.created">, plugin: string | GithubPlugin) {
  const commands: CommandRow[] = [];
  const manifest = await getManifest(context, plugin);
  if (manifest?.commands) {
    for (const [rawName, command] of Object.entries(manifest.commands)) {
      const name = rawName.trim();
      const key = name.toLowerCase();
      commands.push({
        key,
        row: `| \`/${getContent(name)}\` | ${getContent(command.description)} | \`${getContent(command["ubiquity:example"])}\` |`,
      });
    }
  }
  return commands;
}

export async function postHelpCommand(context: GitHubContext<"issue_comment.created">) {
  // Get kernel version and commit hash
  const version = await getPackageVersion();
  const commitHash = await getCommitHash();
  const environment = context.eventHandler.environment;

  const comments = ["| Command | Description | Example |", "|---|---|---|"];
  const commandRows = new Map<string, string>();
  const configuration = await getConfig(context);
  for (const [pluginKey] of Object.entries(configuration.plugins)) {
    let plugin: string | GithubPlugin;
    try {
      plugin = parsePluginIdentifier(pluginKey);
    } catch (error) {
      context.logger.error({ plugin: pluginKey, err: error }, "Invalid plugin identifier; skipping");
      continue;
    }
    for (const command of await parseCommandsFromManifest(context, plugin)) {
      commandRows.set(command.key, command.row);
    }
  }
  if (!commandRows.size) {
    context.logger.warn("No commands found, will not post the help command message.");
  } else {
    if (!commandRows.has("help")) {
      commandRows.set("help", "| `/help` | List all available commands. | `/help` |");
    }
    const commands = [...commandRows.entries()]
      .sort(([a], [b]) => {
        if (a === "help") return -1;
        if (b === "help") return 1;
        return a.localeCompare(b);
      })
      .map(([, row]) => row);
    const footer = `\n\n###### UbiquityOS ${environment.charAt(0).toUpperCase() + environment.slice(1).toLowerCase()} [v${version}](https://github.com/ubiquity-os/ubiquity-os-kernel/releases/tag/v${version}) [${commitHash}](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/${commitHash})`;
    await context.octokit.rest.issues.createComment({
      body: comments.concat(commands).join("\n") + footer,
      issue_number: context.payload.issue.number,
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
    });
  }
}

/**
 * Get the package version
 */
async function getPackageVersion(): Promise<string> {
  // In Cloudflare Worker environment, we can't read files
  // Use a hardcoded version or environment variable
  return process.env.npm_package_version || "7.0.0";
}

/**
 * Get the current git commit hash
 */
async function getCommitHash(): Promise<string> {
  // In Cloudflare Worker environment, we can't run git commands
  // Use an environment variable set at build time
  return process.env.GIT_COMMIT_HASH || "159ea6e";
}

/**
 * Ensures that passed content does not break MD display within the table.
 */
function getContent(content: string | undefined) {
  if (!content) return "-";
  return content.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}
