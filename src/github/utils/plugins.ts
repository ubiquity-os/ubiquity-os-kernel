import { EmitterWebhookEventName } from "@octokit/webhooks";
import { ConfigurationHandler } from "@ubiquity-os/plugin-sdk/configuration";
import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { GitHubContext } from "../github-context";
import { GithubPlugin, parsePluginIdentifier, PluginConfiguration, PluginSettings } from "../types/plugin-configuration";

function isCommentCreatedPayload(
  payload: GitHubContext["payload"]
): payload is GitHubContext<"issue_comment.created" | "pull_request_review_comment.created">["payload"] {
  return "comment" in payload && typeof payload.comment !== "string";
}

export type ResolvedPlugin = {
  key: string;
  target: GithubPlugin;
  settings: PluginSettings;
};

type ManifestWithHomepageUrl = Manifest & { homepage_url?: string };

function formatPluginTarget(target: GithubPlugin) {
  return `${target.owner}/${target.repo}${target.workflowId ? ":" + target.workflowId : ""}${target.ref ? "@" + target.ref : ""}`;
}

export function getWorkerUrlFromManifest(manifest?: Manifest | null) {
  if (!manifest) {
    return null;
  }
  const candidate = manifest as ManifestWithHomepageUrl;
  const homepageUrl = candidate.homepage_url;
  return typeof homepageUrl === "string" && homepageUrl.length ? homepageUrl : null;
}

export async function shouldSkipPlugin(context: GitHubContext, plugin: ResolvedPlugin, event: EmitterWebhookEventName) {
  if (plugin.settings?.skipBotEvents && "sender" in context.payload && context.payload.sender?.type === "Bot") {
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
  return !plugin.settings?.runsOn?.includes(event);
}

export async function getPluginsForEvent(
  context: GitHubContext,
  plugins: PluginConfiguration["plugins"],
  event: EmitterWebhookEventName
): Promise<ResolvedPlugin[]> {
  const allowedPlugins: ResolvedPlugin[] = [];
  for (const [pluginKey, settings] of Object.entries(plugins)) {
    let target: GithubPlugin;
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

export function getManifest(context: GitHubContext, plugin: GithubPlugin) {
  const cfgHandler = new ConfigurationHandler(context.logger, context.octokit);
  return cfgHandler.getManifest(plugin);
}
