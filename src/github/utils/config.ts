import { Value } from "@sinclair/typebox/value";
import { ConfigurationHandler } from "@ubiquity-os/plugin-sdk/configuration";
import { GitHubContext } from "../github-context";
import { configSchema, GithubPlugin, parsePluginIdentifier, PluginConfiguration, PluginSettings } from "../types/plugin-configuration";
import { getManifest } from "./plugins";

export const CONFIG_FULL_PATH = ".github/.ubiquity-os.config.yml";
export const DEV_CONFIG_FULL_PATH = ".github/.ubiquity-os.config.dev.yml";
export const CONFIG_ORG_REPO = ".ubiquity-os";

export async function getConfigurationFromRepo(context: GitHubContext, repository: string, owner: string) {
  const cfgHandler = new ConfigurationHandler(context.logger, context.octokit);
  return cfgHandler.getConfiguration({ owner, repo: repository });
}

export async function getConfig(context: GitHubContext): Promise<PluginConfiguration> {
  const payload = context.payload;
  const defaultConfiguration = Value.Decode(configSchema, Value.Default(configSchema, {}));
  if (!("repository" in payload) || !payload.repository) {
    context.logger.warn("Repository is not defined");
    return defaultConfiguration;
  }
  if (!("owner" in payload.repository) || !payload.repository.owner) {
    context.logger.warn("Owner is not defined");
    return defaultConfiguration;
  }

  const mergedConfiguration: PluginConfiguration = await getConfigurationFromRepo(context, payload.repository.name, payload.repository.owner.login);

  context.logger.debug(
    {
      orgRepo: `${payload.repository.owner.login}/${CONFIG_ORG_REPO}`,
      repo: `${payload.repository.owner.login}/${payload.repository.name}`,
    },
    "Fetching configurations"
  );

  context.logger.debug({ repo: `${payload.repository.owner.login}/${payload.repository.name}` }, "Fetched configurations; Will merge them.");

  const resolvedPlugins: Record<string, PluginSettings> = {};

  context.logger.debug(
    { repo: `${payload.repository.owner.login}/${payload.repository.name}`, plugins: Object.keys(mergedConfiguration.plugins).length },
    "Found plugins enabled"
  );

  for (const [pluginKey, pluginSettings] of Object.entries(mergedConfiguration.plugins)) {
    let pluginIdentifier: GithubPlugin;
    try {
      pluginIdentifier = parsePluginIdentifier(pluginKey);
    } catch (error) {
      context.logger.error({ plugin: pluginKey, err: error }, "Invalid plugin identifier; skipping");
      continue;
    }

    const manifest = await getManifest(context, pluginIdentifier);

    let runsOn = pluginSettings?.runsOn ?? [];
    let shouldSkipBotEvents = pluginSettings?.skipBotEvents;

    if (manifest) {
      if (!runsOn.length) {
        runsOn = manifest["ubiquity:listeners"] ?? [];
      }
      if (shouldSkipBotEvents === undefined) {
        shouldSkipBotEvents = manifest.skipBotEvents ?? true;
      }
    }

    resolvedPlugins[pluginKey] = {
      ...pluginSettings,
      with: pluginSettings?.with ?? {},
      runsOn,
      skipBotEvents: shouldSkipBotEvents,
    };
  }

  return {
    ...mergedConfiguration,
    plugins: resolvedPlugins,
  };
}
