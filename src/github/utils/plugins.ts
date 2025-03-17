import { GithubPlugin, isGithubPlugin, PluginConfiguration } from "../types/plugin-configuration";
import { EmitterWebhookEventName } from "@octokit/webhooks";
import { GitHubContext } from "../github-context";
import { Buffer } from "node:buffer";
import { Value } from "@sinclair/typebox/value";
import { Manifest, manifestSchema } from "@ubiquity-os/plugin-sdk/manifest";

const _manifestCache: Record<string, Manifest> = {};

function isCommentCreatedPayload(
  payload: GitHubContext["payload"]
): payload is GitHubContext<"issue_comment.created" | "pull_request_review_comment.created">["payload"] {
  return "comment" in payload && typeof payload.comment !== "string";
}

export async function shouldSkipPlugin(context: GitHubContext, pluginChain: PluginConfiguration["plugins"][0], event: EmitterWebhookEventName) {
  if (pluginChain.uses[0].skipBotEvents && "sender" in context.payload && context.payload.sender?.type === "Bot") {
    console.log(`Skipping plugin ${JSON.stringify(pluginChain.uses[0].plugin)} in the chain because the sender is a bot`);
    return true;
  }
  const commentEvents = ["issue_comment.created", "pull_request_review_comment.created"] as EmitterWebhookEventName[];
  if (commentEvents.includes(context.key)) {
    const manifest = await getManifest(context, pluginChain.uses[0].plugin);
    if (
      manifest?.commands &&
      !manifest["ubiquity:listeners"]?.includes(context.key) &&
      isCommentCreatedPayload(context.payload) &&
      context.payload.comment?.body.trim().startsWith(`/`) &&
      Object.keys(manifest.commands).length
    ) {
      if (
        !Object.keys(manifest.commands).some(
          (command) => isCommentCreatedPayload(context.payload) && context.payload.comment?.body.trim().startsWith(`/${command}`)
        )
      ) {
        console.log(`Skipping plugin chain ${manifest.name} because command '${context.payload.comment?.body.trim()}' does not match.`, manifest.commands);
        return true;
      }
      return false;
    }
  }
  return !pluginChain.uses?.[0].runsOn?.includes(event);
}

export async function getPluginsForEvent(context: GitHubContext, plugins: PluginConfiguration["plugins"], event: EmitterWebhookEventName) {
  const allowedPlugins = [] as PluginConfiguration["plugins"];
  for (const plugin of plugins) {
    if (!(await shouldSkipPlugin(context, plugin, event))) {
      allowedPlugins.push(plugin);
    }
  }
  return allowedPlugins;
}

export function getManifest(context: GitHubContext, plugin: string | GithubPlugin) {
  return isGithubPlugin(plugin) ? fetchActionManifest(context, plugin) : fetchWorkerManifest(plugin);
}

async function fetchActionManifest(context: GitHubContext<"issue_comment.created">, { owner, repo, ref }: GithubPlugin): Promise<Manifest | null> {
  const manifestKey = ref ? `${owner}:${repo}:${ref}` : `${owner}:${repo}`;
  if (_manifestCache[manifestKey]) {
    return _manifestCache[manifestKey];
  }
  try {
    const { data } = await context.octokit.rest.repos.getContent({
      owner,
      repo,
      path: "manifest.json",
      ref,
    });
    if ("content" in data) {
      const content = Buffer.from(data.content, "base64").toString();
      const contentParsed = JSON.parse(content);
      const manifest = decodeManifest(contentParsed);
      _manifestCache[manifestKey] = manifest;
      return manifest;
    }
  } catch (e) {
    console.error(`Could not find a manifest for Action ${owner}/${repo}: ${e}`);
  }
  return null;
}

async function fetchWorkerManifest(url: string): Promise<Manifest | null> {
  if (_manifestCache[url]) {
    return _manifestCache[url];
  }
  const manifestUrl = `${url}/manifest.json`;
  try {
    const result = await fetch(manifestUrl);
    const jsonData = await result.json();
    const manifest = decodeManifest(jsonData);
    _manifestCache[url] = manifest;
    return manifest;
  } catch (e) {
    console.error(`Could not find a manifest for Worker ${manifestUrl}: ${e}`);
  }
  return null;
}

function decodeManifest(manifest: unknown) {
  const errors = [...Value.Errors(manifestSchema, manifest)];
  if (errors.length) {
    for (const error of errors) {
      console.dir(error, { depth: null });
    }
    throw new Error("Manifest is invalid.");
  }
  const defaultManifest = Value.Default(manifestSchema, manifest);
  return defaultManifest as Manifest;
}
