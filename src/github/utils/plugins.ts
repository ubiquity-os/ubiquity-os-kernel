import { EmitterWebhookEventName } from "@octokit/webhooks";
import { Value } from "@sinclair/typebox/value";
import { Manifest, manifestSchema } from "@ubiquity-os/plugin-sdk/manifest";
import { Buffer } from "node:buffer";
import { GitHubContext } from "../github-context";
import { GithubPlugin, PluginConfiguration, PluginSettings, isGithubPlugin, parsePluginIdentifier } from "../types/plugin-configuration";

const _manifestCache: Record<string, Manifest> = {};

function isCommentCreatedPayload(
  payload: GitHubContext["payload"]
): payload is GitHubContext<"issue_comment.created" | "pull_request_review_comment.created">["payload"] {
  return "comment" in payload && typeof payload.comment !== "string";
}

export type ResolvedPlugin = {
  key: string;
  target: string | GithubPlugin;
  settings: PluginSettings;
};

function formatPluginTarget(target: string | GithubPlugin) {
  return typeof target === "string"
    ? target
    : `${target.owner}/${target.repo}${target.workflowId ? ":" + target.workflowId : ""}${target.ref ? "@" + target.ref : ""}`;
}

export async function shouldSkipPlugin(context: GitHubContext, plugin: ResolvedPlugin, event: EmitterWebhookEventName) {
  if (plugin.settings.skipBotEvents && "sender" in context.payload && context.payload.sender?.type === "Bot") {
    context.logger.debug({ plugin: formatPluginTarget(plugin.target) }, "Skipping plugin because sender is bot");
    return true;
  }
  const commentEvents = ["issue_comment.created", "pull_request_review_comment.created"] as EmitterWebhookEventName[];
  if (commentEvents.includes(context.key)) {
    const manifest = await getManifest(context, plugin.target);
    if (
      manifest?.commands &&
      !manifest["ubiquity:listeners"]?.includes(context.key as keyof Manifest["ubiquity:listeners"]) &&
      isCommentCreatedPayload(context.payload) &&
      context.payload.comment?.body.trim().startsWith(`/`) &&
      Object.keys(manifest.commands).length
    ) {
      if (
        !Object.keys(manifest.commands).some(
          (command) => isCommentCreatedPayload(context.payload) && context.payload.comment?.body.trim().startsWith(`/${command}`)
        )
      ) {
        context.logger.debug(
          { manifest: manifest.name, command: context.payload.comment?.body.trim(), commands: Object.keys(manifest.commands) },
          "Skipping plugin because of chain command mismatch"
        );
        return true;
      }
      return false;
    }
  }
  return !plugin.settings.runsOn?.includes(event);
}

export async function getPluginsForEvent(
  context: GitHubContext,
  plugins: PluginConfiguration["plugins"],
  event: EmitterWebhookEventName
): Promise<ResolvedPlugin[]> {
  const allowedPlugins: ResolvedPlugin[] = [];
  for (const [pluginKey, settings] of Object.entries(plugins)) {
    let target: string | GithubPlugin;
    try {
      target = parsePluginIdentifier(pluginKey);
    } catch (error) {
      context.logger.error({ plugin: pluginKey, err: error }, "Invalid plugin identifier; skipping");
      continue;
    }
    const resolvedPlugin: ResolvedPlugin = {
      key: pluginKey,
      target,
      settings,
    };
    if (!(await shouldSkipPlugin(context, resolvedPlugin, event))) {
      allowedPlugins.push(resolvedPlugin);
    }
  }
  return allowedPlugins;
}

export function getManifest(context: GitHubContext, plugin: string | GithubPlugin) {
  return isGithubPlugin(plugin) ? fetchActionManifest(context, plugin) : fetchWorkerManifest(context, plugin);
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
      const manifest = decodeManifest(context, contentParsed);
      _manifestCache[manifestKey] = manifest;
      return manifest;
    }
  } catch (e) {
    context.logger.error({ owner, repo, err: e }, "Could not find a manifest for Action");
  }
  return null;
}

async function fetchWorkerManifest(context: GitHubContext, url: string): Promise<Manifest | null> {
  if (_manifestCache[url]) {
    return _manifestCache[url];
  }
  const manifestUrl = `${url}/manifest.json`;
  try {
    const result = await fetch(manifestUrl);
    const jsonData = await result.json();
    const manifest = decodeManifest(context, jsonData);
    _manifestCache[url] = manifest;
    return manifest;
  } catch (e) {
    context.logger.error({ manifestUrl, err: e }, "Could not find a manifest for Worker");
  }
  return null;
}

function decodeManifest(context: GitHubContext, manifest: unknown) {
  const errors = [...Value.Errors(manifestSchema, manifest)];
  if (errors.length) {
    for (const error of errors) {
      context.logger.error({ error }, "Manifest validation error");
    }
    throw new Error("Manifest is invalid.");
  }
  const defaultManifest = Value.Default(manifestSchema, manifest);
  return defaultManifest as Manifest;
}
