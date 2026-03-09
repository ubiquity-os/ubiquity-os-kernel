import { EmitterWebhookEventName } from "@octokit/webhooks";
import { type TSchema, Type as T } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Manifest, manifestSchema as sdkManifestSchema } from "@ubiquity-os/plugin-sdk/manifest";
import { Buffer } from "node:buffer";
import { GitHubContext } from "../github-context.ts";
import { GithubPlugin, isGithubPlugin, parsePluginIdentifier, PluginConfiguration, PluginSettings } from "../types/plugin-configuration.ts";
import { getEnvValue } from "./env.ts";
import { isPlainObject } from "./helpers.ts";

const MAX_MANIFEST_CACHE_SIZE = 100;
type ManifestCacheEntry = {
  manifest: Manifest;
  ref?: string;
};

export type ManifestResolution = {
  manifest: Manifest | null;
  ref?: string;
};

const manifestCache = new Map<string, ManifestCacheEntry>();
const kernelManifestSchema = T.Intersect([
  T.Omit(sdkManifestSchema as unknown as TSchema, ["ubiquity:listeners"]),
  T.Object({
    // Allow kernel-defined synthetic events (e.g. "kernel.plugin_error") without rejecting the entire manifest.
    "ubiquity:listeners": T.Optional(T.Array(T.String({ minLength: 1 }), { default: [] })),
  }),
]);

function readManifestCache(key: string): ManifestCacheEntry | null {
  return manifestCache.get(key) ?? null;
}

function setManifestCache(key: string, entry: ManifestCacheEntry) {
  if (manifestCache.has(key)) {
    manifestCache.delete(key);
  } else if (manifestCache.size >= MAX_MANIFEST_CACHE_SIZE) {
    const oldestKey = manifestCache.keys().next().value;
    if (oldestKey) manifestCache.delete(oldestKey);
  }
  manifestCache.set(key, entry);
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
  return getManifestResolution(context, plugin).then((resolution) => resolution.manifest);
}

export function getManifestResolution(context: GitHubContext, plugin: string | GithubPlugin): Promise<ManifestResolution> {
  return isGithubPlugin(plugin) ? fetchActionManifest(context, plugin) : fetchWorkerManifest(context, plugin);
}

function normalizeRefCandidate(ref: string): string {
  return String(ref || "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/tags\//, "");
}

function pushUnique(values: string[], value: string) {
  if (!value) return;
  if (!values.includes(value)) {
    values.push(value);
  }
}

export function buildManifestRefCandidates(ref: string | undefined): (string | undefined)[] {
  if (!ref) {
    return [undefined];
  }

  const normalized = normalizeRefCandidate(ref);
  if (!normalized) {
    return [undefined];
  }

  const refs: string[] = [];
  if (normalized.startsWith("dist/")) {
    pushUnique(refs, normalized);
  } else {
    pushUnique(refs, `dist/${normalized}`);
    pushUnique(refs, normalized);
  }

  return refs;
}

async function fetchActionManifest(context: GitHubContext, { owner, repo, ref }: GithubPlugin): Promise<ManifestResolution> {
  const manifestKey = ref ? `${owner}:${repo}:${ref}` : `${owner}:${repo}`;
  const useCache = isManifestCacheEnabled(context);
  if (useCache) {
    const cached = readManifestCache(manifestKey);
    if (cached) return { manifest: cached.manifest, ref: cached.ref };
  }
  const refCandidates = buildManifestRefCandidates(ref);
  for (const refCandidate of refCandidates) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
      try {
        const { data } = await context.octokit.rest.repos.getContent({
          owner,
          repo,
          path: "manifest.json",
          ref: refCandidate,
          request: { signal: controller.signal },
        });
        if ("content" in data) {
          const content = Buffer.from(data.content, "base64").toString();
          const contentParsed = JSON.parse(content);
          const manifest = decodeManifest(context, contentParsed);
          if (useCache) {
            setManifestCache(manifestKey, { manifest, ref: refCandidate });
          }
          return { manifest, ref: refCandidate };
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      const status = e && typeof e === "object" && "status" in e ? Number((e as { status?: number }).status) : null;
      if (status === 404) {
        context.logger.debug({ owner, repo, ref: refCandidate }, "Action manifest not found for ref candidate");
        continue;
      }
      context.logger.warn({ owner, repo, ref: refCandidate, err: e }, "Failed to fetch action manifest for ref candidate");
    }
  }
  context.logger.error({ owner, repo, refCandidates }, "Could not find a manifest for Action");
  return { manifest: null };
}

async function fetchWorkerManifest(context: GitHubContext, url: string): Promise<ManifestResolution> {
  const useCache = isManifestCacheEnabled(context);
  if (useCache) {
    const cached = readManifestCache(url);
    if (cached) return { manifest: cached.manifest, ref: cached.ref };
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
        return { manifest: null };
      }
      const jsonData = await result.json();
      const manifest = decodeManifest(context, jsonData);
      if (useCache) {
        setManifestCache(url, { manifest });
      }
      return { manifest };
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    context.logger.error({ manifestUrl, err: e }, "Could not find a manifest for Worker");
  }
  return { manifest: null };
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

export function getWorkerUrlFromManifest(manifest?: Manifest | null) {
  if (!manifest) {
    return null;
  }
  const homepageUrl = manifest.homepage_url;
  return typeof homepageUrl === "string" && homepageUrl.length ? homepageUrl : null;
}
