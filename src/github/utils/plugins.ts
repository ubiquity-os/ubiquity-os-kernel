import { EmitterWebhookEventName } from "@octokit/webhooks";
import { Type as T, type TProperties } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Manifest, manifestSchema as sdkManifestSchema } from "@ubiquity-os/plugin-sdk/manifest";
import { Buffer } from "node:buffer";
import { GitHubContext } from "../github-context.ts";
import { GithubPlugin, PluginConfiguration, PluginSettings, isGithubPlugin, parsePluginIdentifier } from "../types/plugin-configuration.ts";
import { getEnvValue } from "./env.ts";
import { getKvClient, type KvKey } from "./kv-client.ts";
import { isPlainObject } from "./helpers.ts";

const MANIFEST_CACHE_TTL_MS = 10 * 60_000;
const MANIFEST_FETCH_TIMEOUT_MS = 5_000;
const MANIFEST_CACHE_PREFIX: KvKey = ["ubiquityos", "kernel", "manifest"];
const kernelManifestSchema = T.Object({
  ...(sdkManifestSchema.properties as unknown as TProperties),
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

  const disableCache = getEnvValue("UOS_DISABLE_MANIFEST_CACHE");
  if (!disableCache) return true;
  return !["1", "true", "yes"].includes(disableCache.toLowerCase());
}

function formatPluginTarget(target: string | GithubPlugin) {
  return typeof target === "string"
    ? target
    : `${target.owner}/${target.repo}${target.workflowId ? ":" + target.workflowId : ""}${target.ref ? "@" + target.ref : ""}`;
}

function buildManifestCacheKeyForAction(owner: string, repo: string, ref?: string): KvKey {
  return [...MANIFEST_CACHE_PREFIX, "action", owner, repo, ref ?? "default"];
}

function buildManifestCacheKeyForWorker(url: string): KvKey {
  return [...MANIFEST_CACHE_PREFIX, "worker", url];
}

async function readManifestCache(context: GitHubContext, kv: Awaited<ReturnType<typeof getKvClient>>, key: KvKey): Promise<Manifest | null> {
  if (!kv) return null;
  try {
    const { value } = await kv.get(key);
    if (!value || typeof value !== "object") return null;
    return value as Manifest;
  } catch (error) {
    context.logger.debug({ err: error }, "Failed to read manifest cache (non-fatal).");
    return null;
  }
}

async function writeManifestCache(context: GitHubContext, kv: Awaited<ReturnType<typeof getKvClient>>, key: KvKey, manifest: Manifest): Promise<void> {
  if (!kv) return;
  try {
    await kv.set(key, manifest, { expireIn: MANIFEST_CACHE_TTL_MS });
  } catch (error) {
    context.logger.debug({ err: error }, "Failed to write manifest cache (non-fatal).");
  }
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
  const useCache = isManifestCacheEnabled(context);
  const kv = useCache ? await getKvClient(context.logger) : null;
  if (useCache) {
    const cached = await readManifestCache(context, kv, buildManifestCacheKeyForAction(owner, repo, ref));
    if (cached) return cached;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MANIFEST_FETCH_TIMEOUT_MS);
    try {
      const { data } = await context.octokit.rest.repos.getContent({
        owner,
        repo,
        path: "manifest.json",
        ref,
        request: { signal: controller.signal },
      });
      if (!data || Array.isArray(data) || typeof data !== "object") {
        context.logger.warn({ owner, repo, ref }, "Manifest payload missing for Action");
        return null;
      }
      if (!("content" in data) || typeof data.content !== "string") {
        context.logger.warn({ owner, repo, ref }, "Manifest content missing for Action");
        return null;
      }
      const content = Buffer.from(data.content, "base64").toString();
      const contentParsed = JSON.parse(content);
      const manifest = decodeManifest(context, contentParsed);
      if (useCache) {
        await writeManifestCache(context, kv, buildManifestCacheKeyForAction(owner, repo, ref), manifest);
      }
      return manifest;
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    if (isAbortError(e)) {
      const message = e instanceof Error ? e.message : String(e);
      context.logger.warn({ owner, repo, timeoutMs: MANIFEST_FETCH_TIMEOUT_MS, error: message }, "Manifest fetch timed out for Action");
    } else {
      const message = e instanceof Error ? e.message : String(e);
      context.logger.error({ owner, repo, error: message }, "Could not find a manifest for Action");
    }
  }
  return null;
}

async function fetchWorkerManifest(context: GitHubContext, url: string): Promise<Manifest | null> {
  const useCache = isManifestCacheEnabled(context);
  const kv = useCache ? await getKvClient(context.logger) : null;
  if (useCache) {
    const cached = await readManifestCache(context, kv, buildManifestCacheKeyForWorker(url));
    if (cached) return cached;
  }
  const manifestUrl = `${url}/manifest.json`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MANIFEST_FETCH_TIMEOUT_MS);
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
        await writeManifestCache(context, kv, buildManifestCacheKeyForWorker(url), manifest);
      }
      return manifest;
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    if (isAbortError(e)) {
      context.logger.warn({ manifestUrl, timeoutMs: MANIFEST_FETCH_TIMEOUT_MS, err: e }, "Manifest fetch timed out for Worker");
    } else {
      context.logger.error({ manifestUrl, err: e }, "Could not find a manifest for Worker");
    }
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

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { name?: string; code?: number; message?: string };
  return err.name === "AbortError" || err.code === 20 || err.message === "The signal has been aborted";
}
