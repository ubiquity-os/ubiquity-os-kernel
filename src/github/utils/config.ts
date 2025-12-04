import { TransformDecodeCheckError, Value, ValueError } from "@sinclair/typebox/value";
import YAML from "js-yaml";
import { YAMLError } from "yaml";
import { GitHubContext } from "../github-context";
import { GithubPlugin, PluginConfiguration, PluginSettings, configSchema, configSchemaValidator, parsePluginIdentifier } from "../types/plugin-configuration";
import { getManifest } from "./plugins";

export const CONFIG_FULL_PATH = ".github/.ubiquity-os.config.yml";
export const DEV_CONFIG_FULL_PATH = ".github/.ubiquity-os.config.dev.yml";
export const CONFIG_ORG_REPO = ".ubiquity-os";

export async function getConfigurationFromRepo(context: GitHubContext, repository: string, owner: string) {
  const rawData = await download({
    context,
    repository,
    owner,
  });

  context.logger.debug({ owner, repository }, "Downloaded configuration file");
  if (!rawData) {
    context.logger.debug({ owner, repository }, "No raw configuration data");
    return { config: null, errors: null, rawData: null };
  }

  const { yaml, errors } = parseYaml(context, rawData);
  const targetRepoConfiguration: PluginConfiguration | null = yaml as PluginConfiguration;
  context.logger.debug({ owner, repository }, "Decoding configuration");
  if (targetRepoConfiguration) {
    try {
      const configSchemaWithDefaults = Value.Default(configSchema, targetRepoConfiguration) as Readonly<unknown>;
      const errors = configSchemaValidator.testReturningErrors(configSchemaWithDefaults);
      if (errors !== null) {
        for (const error of errors) {
          context.logger.error({ err: error }, "Configuration validation error");
        }
      }
      const decodedConfig = Value.Decode(configSchema, configSchemaWithDefaults);
      return { config: decodedConfig, errors, rawData };
    } catch (error) {
      context.logger.error({ err: error, owner, repository }, "Error decoding configuration; Will ignore.");
      return { config: null, errors: [error instanceof TransformDecodeCheckError ? error.error : error] as ValueError[], rawData };
    }
  }
  context.logger.error({ owner, repository, errors }, "YAML could not be decoded");
  return { config: null, errors, rawData };
}

/**
 * Merge configurations based on their 'plugins' keys
 */
function mergeConfigurations(configuration1: PluginConfiguration, configuration2: PluginConfiguration): PluginConfiguration {
  const mergedPlugins = {
    ...configuration1.plugins,
    ...configuration2.plugins,
  };
  return {
    ...configuration1,
    ...configuration2,
    plugins: mergedPlugins,
  };
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

  let mergedConfiguration: PluginConfiguration = defaultConfiguration;

  context.logger.debug(
    {
      orgRepo: `${payload.repository.owner.login}/${CONFIG_ORG_REPO}`,
      repo: `${payload.repository.owner.login}/${payload.repository.name}`,
    },
    "Fetching configurations"
  );
  const orgConfig = await getConfigurationFromRepo(context, CONFIG_ORG_REPO, payload.repository.owner.login);
  const repoConfig = await getConfigurationFromRepo(context, payload.repository.name, payload.repository.owner.login);

  context.logger.debug({ repo: `${payload.repository.owner.login}/${payload.repository.name}` }, "Fetched configurations; Will merge them.");

  if (orgConfig.config) {
    mergedConfiguration = mergeConfigurations(mergedConfiguration, orgConfig.config);
  }
  if (repoConfig.config) {
    mergedConfiguration = mergeConfigurations(mergedConfiguration, repoConfig.config);
  }

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

async function download({ context, repository, owner }: { context: GitHubContext; repository: string; owner: string }): Promise<string | null> {
  if (!repository || !owner) {
    context.logger.error("Repo or owner is not defined, cannot download the requested file");
    return null;
  }
  const filePath = context.eventHandler.environment === "production" ? CONFIG_FULL_PATH : DEV_CONFIG_FULL_PATH;
  try {
    context.logger.debug({ owner, repository, filePath }, "Attempting to fetch configuration");
    const { data, headers } = await context.octokit.rest.repos.getContent({
      owner,
      repo: repository,
      path: filePath,
      mediaType: { format: "raw" },
    });
    context.logger.debug({ owner, repository, filePath, rateLimitRemaining: headers?.["x-ratelimit-remaining"], data }, "Configuration file found");
    return data as unknown as string; // this will be a string if media format is raw
  } catch (err) {
    // In case of a missing config, do not log it as an error
    if (err && typeof err === "object" && "status" in err && err.status === 404) {
      context.logger.debug({ owner, repository, filePath }, "No configuration file found");
    } else {
      context.logger.error({ err, owner, repository, filePath }, "Failed to download the requested file");
    }
    return null;
  }
}

export function parseYaml(context: GitHubContext, data: null | string) {
  context.logger.trace({ data }, "Will attempt to parse YAML data");
  try {
    if (data) {
      const parsedData = YAML.load(data);
      context.logger.trace({ parsedData }, "Parsed yaml data");
      return { yaml: parsedData ?? null, errors: null };
    }
  } catch (error) {
    context.logger.error({ error }, "Error parsing YAML");
    return { errors: [error] as YAMLError[], yaml: null };
  }
  context.logger.debug("Could not parse YAML");
  return { yaml: null, errors: null };
}
