import { EmitterWebhookEventName } from "@octokit/webhooks";
import { Type as T } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Manifest, manifestSchema as sdkManifestSchema } from "@ubiquity-os/plugin-sdk/manifest";
import { Buffer } from "node:buffer";
import { GitHubContext } from "../github-context";
import { GithubPlugin, PluginConfiguration, PluginSettings, isGithubPlugin, parsePluginIdentifier } from "../types/plugin-configuration";

const _manifestCache: Record<string, Manifest> = {};
const kernelManifestSchema = T.Object({
  ...sdkManifestSchema.properties,
  // Allow kernel-defined synthetic events (e.g. "kernel.plugin_error") without rejecting the entire manifest.
  "ubiquity:listeners": T.Optional(T.Array(T.String({ minLength: 1 }), { default: [] })),
});

export type ResolvedPlugin = {
  key: string;
  target: string | GithubPlugin;
  settings: PluginSettings;
};

function isManifestCacheEnabled(context: GitHubContext) {
  const environment = String(context.eventHandler?.environment ?? "").toLowerCase();
  // Keep non-production environments hot-reload friendly.
  if (environment !== "production" && environment !== "prod") {
    return false;
  }

  const disableCache = typeof process !== "undefined" ? process.env.UOS_DISABLE_MANIFEST_CACHE : undefined;
  return !disableCache || !["1", "true", "yes"].includes(disableCache.toLowerCase());
}

function formatPluginTarget(target: string | GithubPlugin) {
  return typeof target === "string"
    ? target
    : `${target.owner}/${target.repo}${target.workflowId ? ":" + target.workflowId : ""}${target.ref ? "@" + target.ref : ""}`;
}

export async function shouldSkipPlugin(context: GitHubContext, plugin: ResolvedPlugin, event: EmitterWebhookEventName) {
  if (plugin.settings?.skipBotEvents && "sender" in context.payload && context.payload.sender?.type === "Bot") {
    context.logger.debug({ plugin: formatPluginTarget(plugin.target) }, "Skipping plugin because sender is bot");
    return true;
  }
  const runsOn = plugin.settings?.runsOn;
  return Array.isArray(runsOn) && runsOn.length > 0 && !runsOn.includes(event);
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
  const useCache = isManifestCacheEnabled(context);
  if (useCache && _manifestCache[manifestKey]) {
    return _manifestCache[manifestKey];
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
    try {
      const { data } = await context.octokit.rest.repos.getContent({
        owner,
        repo,
        path: "manifest.json",
        ref,
        request: { signal: controller.signal },
      });
      if ("content" in data) {
        const content = Buffer.from(data.content, "base64").toString();
        const contentParsed = JSON.parse(content);
        const manifest = decodeManifest(context, contentParsed);
        if (useCache) {
          _manifestCache[manifestKey] = manifest;
        }
        return manifest;
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    context.logger.error({ owner, repo, err: e }, "Could not find a manifest for Action");
  }
  return null;
}

async function fetchWorkerManifest(context: GitHubContext, url: string): Promise<Manifest | null> {
  const useCache = isManifestCacheEnabled(context);
  if (useCache && _manifestCache[url]) {
    return _manifestCache[url];
  }
  const manifestUrl = `${url}/manifest.json`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
    try {
      const result = await fetch(manifestUrl, { signal: controller.signal });
      const jsonData = await result.json();
      const manifest = decodeManifest(context, jsonData);
      if (useCache) {
        _manifestCache[url] = manifest;
      }
      return manifest;
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    context.logger.error({ manifestUrl, err: e }, "Could not find a manifest for Worker");
  }
  return null;
}

function decodeManifest(context: GitHubContext, manifest: unknown) {
  const errors = [...Value.Errors(kernelManifestSchema, manifest)];
  if (errors.length) {
    for (const error of errors) {
      context.logger.error({ error }, "Manifest validation error");
    }
    throw new Error("Manifest is invalid.");
  }
  const defaultManifest = Value.Default(kernelManifestSchema, manifest);
  return defaultManifest as Manifest;
}
