import { getConfig } from "../utils/config";
import { GithubPlugin, isGithubPlugin } from "../types/plugin-configuration";
import { GitHubContext } from "../github-context";
import { Manifest, manifestSchema, manifestValidator } from "../../types/manifest";
import { Value } from "@sinclair/typebox/value";
import { Buffer } from "node:buffer";

async function parseCommandsFromManifest(context: GitHubContext<"issue_comment.created">, plugin: string | GithubPlugin) {
  const commands: string[] = [];
  const manifest = await (isGithubPlugin(plugin) ? fetchActionManifest(context, plugin) : fetchWorkerManifest(plugin));
  if (manifest) {
    Value.Default(manifestSchema, manifest);
    const errors = manifestValidator.testReturningErrors(manifest);
    if (errors !== null) {
      console.error(`Failed to load the manifest for ${JSON.stringify(plugin)}`);
      for (const error of errors) {
        console.error(error);
      }
    } else {
      if (manifest?.commands) {
        for (const [key, value] of Object.entries(manifest.commands)) {
          commands.push(`| \`/${getContent(key)}\` | ${getContent(value.description)} | \`${getContent(value["ubiquity:example"])}\` |`);
        }
      }
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
  await context.octokit.issues.createComment({
    body: comments.concat(commands.sort()).join("\n"),
    issue_number: context.payload.issue.number,
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
  });
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
    console.warn(`Could not find a manifest for ${owner}/${repo}: ${e}`);
  }
  return null;
}

async function fetchWorkerManifest(url: string): Promise<Manifest | null> {
  const manifestUrl = `${url}/manifest.json`;
  try {
    const result = await fetch(manifestUrl);
    return (await result.json()) as Manifest;
  } catch (e) {
    console.warn(`Could not find a manifest for ${manifestUrl}: ${e}`);
  }
  return null;
}
