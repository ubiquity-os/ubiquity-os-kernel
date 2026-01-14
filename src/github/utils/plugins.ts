import { EmitterWebhookEventName } from "@octokit/webhooks";
import { Type as T, type TProperties } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Manifest, manifestSchema as sdkManifestSchema } from "@ubiquity-os/plugin-sdk/manifest";
import { Buffer } from "node:buffer";
import { GitHubContext } from "../github-context.ts";
import { GithubPlugin, PluginConfiguration, PluginSettings, isGithubPlugin, parsePluginIdentifier } from "../types/plugin-configuration.ts";
import { getEnvValue } from "./env.ts";
import { isPlainObject } from "./helpers.ts";

const MAX_MANIFEST_CACHE_SIZE = 100;
const manifestCache = new Map<string, Manifest>();
const kernelManifestSchema = T.Object({
  ...(sdkManifestSchema.properties as unknown as TProperties),
  // Allow kernel-defined synthetic events (e.g. "kernel.plugin_error") without rejecting the entire manifest.
  "ubiquity:listeners": T.Optional(T.Array(T.String({ minLength: 1 }), { default: [] })),
});

function readManifestCache(key: string): Manifest | null {
  return manifestCache.get(key) ?? null;
}

function setManifestCache(key: string, manifest: Manifest) {
  if (manifestCache.has(key)) {
    manifestCache.delete(key);
  } else if (manifestCache.size >= MAX_MANIFEST_CACHE_SIZE) {
    const oldestKey = manifestCache.keys().next().value;
    if (oldestKey) manifestCache.delete(oldestKey);
  }
  manifestCache.set(key, manifest);
}

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

  const disableCache = getEnvValue("UOS_DISABLE_MANIFEST_CACHE");
  if (!disableCache) return true;
  return !["1", "true", "yes"].includes(disableCache.toLowerCase());
}

function formatPluginTarget(target: string | GithubPlugin) {
  return typeof target === "string"
    ? target
    : `${target.owner}/${target.repo}${target.workflowId ? ":" + target.workflowId : ""}${target.ref ? "@" + target.ref : ""}`;
}

export function mergeWithDefaults<T>(defaults: T, overrides: unknown): T {
  if (!isPlainObject(defaults) || !isPlainObject(overrides)) {
    return (overrides ?? defaults) as T;
  }
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      continue;
    }
    const defaultValue = (defaults as Record<string, unknown>)[key];
    if (isPlainObject(defaultValue) && isPlainObject(value)) {
      result[key] = mergeWithDefaults(defaultValue, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export async function shouldSkipPlugin(context: GitHubContext, plugin: ResolvedPlugin, event: EmitterWebhookEventName) {
  if (plugin.settings?.skipBotEvents && "sender" in context.payload && context.payload.sender?.type === "Bot") {
    context.logger.debug({ plugin: formatPluginTarget(plugin.target) }, "Skipping plugin because sender is bot");
    return true;
  }
  const runsOn = plugin.settings?.runsOn;
  if (Array.isArray(runsOn)) {
    if (runsOn.length === 0) {
      context.logger.debug({ plugin: formatPluginTarget(plugin.target) }, "Skipping plugin because runsOn is empty");
      return true;
    }
    return !runsOn.includes(event);
  }
  return false;
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

async function fetchActionManifest(context: GitHubContext, { owner, repo, ref }: GithubPlugin): Promise<Manifest | null> {
  const manifestKey = ref ? `${owner}:${repo}:${ref}` : `${owner}:${repo}`;
  const useCache = isManifestCacheEnabled(context);
  if (useCache) {
    const cached = readManifestCache(manifestKey);
    if (cached) return cached;
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
          setManifestCache(manifestKey, manifest);
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
  if (useCache) {
    const cached = readManifestCache(url);
    if (cached) return cached;
  }
  const manifestUrl = `${url}/manifest.json`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
    try {
      const result = await fetch(manifestUrl, { signal: controller.signal });
      if (!result.ok) {
        const body = await result.text().catch(() => "");
        context.logger.error(
          {
            manifestUrl,
            status: result.status,
            statusText: result.statusText,
            body: body.slice(0, 500),
          },
          "Could not find a manifest for Worker"
        );
        return null;
      }
      const jsonData = await result.json();
      const manifest = decodeManifest(context, jsonData);
      if (useCache) {
        setManifestCache(url, manifest);
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
  const manifestWithDefaults = mergeWithDefaults(Value.Create(kernelManifestSchema), manifest);
  const errors = [...Value.Errors(kernelManifestSchema, manifestWithDefaults)];
  if (errors.length) {
    for (const error of errors) {
      context.logger.warn({ error }, "Manifest validation error");
    }
    throw new Error("Manifest is invalid.");
  }
  return manifestWithDefaults as Manifest;
}
