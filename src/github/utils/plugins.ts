import { GithubPlugin, isGithubPlugin, PluginConfiguration } from "../types/plugin-configuration";
import { EmitterWebhookEventName } from "@octokit/webhooks";
import { GitHubContext } from "../github-context";
import { Manifest, manifestSchema } from "@ubiquity-os/plugin-sdk/manifest";
import { Buffer } from "node:buffer";
import { Value } from "@sinclair/typebox/value";

const _manifestCache: Record<string, Manifest> = {};

export function getPluginsForEvent(plugins: PluginConfiguration["plugins"], event: EmitterWebhookEventName) {
  return plugins.filter((plugin) => {
    return plugin.uses?.[0].runsOn?.includes(event);
  });
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
      const manifest = decodeManifest(JSON.parse(content));
      _manifestCache[manifestKey] = manifest;
      return manifest;
    }
  } catch (e) {
    console.warn(`Could not find a manifest for Action ${owner}/${repo}: ${e}`);
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
    console.warn(`Could not find a manifest for Worker ${manifestUrl}: ${e}`);
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
