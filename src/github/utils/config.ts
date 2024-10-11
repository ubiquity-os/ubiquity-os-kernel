import { TransformDecodeCheckError, Value, ValueError } from "@sinclair/typebox/value";
import YAML, { YAMLError } from "yaml";
import { GitHubContext } from "../github-context";
import { expressionRegex } from "../types/plugin";
import { configSchema, configSchemaValidator, PluginConfiguration } from "../types/plugin-configuration";
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
  const { yaml, errors } = parseYaml(rawData);
  const targetRepoConfiguration: PluginConfiguration | null = yaml;
  if (targetRepoConfiguration) {
    try {
      const configSchemaWithDefaults = Value.Default(configSchema, targetRepoConfiguration) as Readonly<unknown>;
      const errors = configSchemaValidator.testReturningErrors(configSchemaWithDefaults);
      if (errors !== null) {
        for (const error of errors) {
          console.error(error);
        }
      }
      return { config: Value.Decode(configSchema, configSchemaWithDefaults), errors, rawData };
    } catch (error) {
      console.error(`Error decoding configuration for ${owner}/${repository}, will ignore.`, error);
      return { config: null, errors: [error instanceof TransformDecodeCheckError ? error.error : error] as ValueError[], rawData };
    }
  }
  return { config: null, errors, rawData };
}

/**
 * Merge configurations based on their 'plugins' keys
 */
function mergeConfigurations(configuration1: PluginConfiguration, configuration2: PluginConfiguration): PluginConfiguration {
  const mergedConfiguration = { ...configuration1 };
  if (configuration2.plugins?.length) {
    mergedConfiguration.plugins = configuration2.plugins;
  }
  return mergedConfiguration;
}

export async function getConfig(context: GitHubContext): Promise<PluginConfiguration> {
  const payload = context.payload;
  const defaultConfiguration = Value.Decode(configSchema, Value.Default(configSchema, {}));
  if (!("repository" in payload) || !payload.repository) {
    console.warn("Repository is not defined");
    return defaultConfiguration;
  }
  if (!("owner" in payload.repository) || !payload.repository.owner) {
    console.warn("Owner is not defined");
    return defaultConfiguration;
  }

  let mergedConfiguration: PluginConfiguration = defaultConfiguration;

  const configurations = await Promise.all([
    getConfigurationFromRepo(context, CONFIG_ORG_REPO, payload.repository.owner.login),
    getConfigurationFromRepo(context, payload.repository.name, payload.repository.owner.login),
  ]);

  configurations.forEach((configuration) => {
    if (configuration.config) {
      mergedConfiguration = mergeConfigurations(mergedConfiguration, configuration.config);
    }
  });

  checkPluginChains(mergedConfiguration);

  for (const plugin of mergedConfiguration.plugins) {
    if (plugin.uses.length && !plugin.uses[0].runsOn?.length) {
      const manifest = await getManifest(context, plugin.uses[0].plugin);
      if (manifest) {
        plugin.uses[0].runsOn = manifest["ubiquity:listeners"] || [];
      }
    }
  }
  return mergedConfiguration;
}

function checkPluginChains(config: PluginConfiguration) {
  for (const plugin of config.plugins) {
    const allIds = checkPluginChainUniqueIds(plugin);
    checkPluginChainExpressions(plugin, allIds);
  }
}

function checkPluginChainUniqueIds(plugin: PluginConfiguration["plugins"][0]) {
  const allIds = new Set<string>();
  for (const use of plugin.uses) {
    if (!use.id) continue;

    if (allIds.has(use.id)) {
      throw new Error(`Duplicate id ${use.id} in plugin chain`);
    }
    allIds.add(use.id);
  }
  return allIds;
}

function checkPluginChainExpressions(plugin: PluginConfiguration["plugins"][0], allIds: Set<string>) {
  const calledIds = new Set<string>();
  for (const use of plugin.uses) {
    if (!use.id) continue;
    for (const key of Object.keys(use.with)) {
      const value = use.with[key];
      if (typeof value !== "string") continue;
      checkExpression(value, allIds, calledIds);
    }
    calledIds.add(use.id);
  }
}

function checkExpression(value: string, allIds: Set<string>, calledIds: Set<string>) {
  const matches = value.match(expressionRegex);
  if (!matches) {
    return;
  }
  const parts = matches[1].split(".");
  if (parts.length !== 3) {
    throw new Error(`Invalid expression: ${value}`);
  }
  const id = parts[0];
  if (!allIds.has(id)) {
    throw new Error(`Expression ${value} refers to non-existent id ${id}`);
  }
  if (!calledIds.has(id)) {
    throw new Error(`Expression ${value} refers to plugin id ${id} before it is called`);
  }
  if (parts[1] !== "output") {
    throw new Error(`Invalid expression: ${value}`);
  }
}

async function download({ context, repository, owner }: { context: GitHubContext; repository: string; owner: string }): Promise<string | null> {
  if (!repository || !owner) throw new Error("Repo or owner is not defined");
  try {
    const { data } = await context.octokit.rest.repos.getContent({
      owner,
      repo: repository,
      path: context.eventHandler.environment === "production" ? CONFIG_FULL_PATH : DEV_CONFIG_FULL_PATH,
      mediaType: { format: "raw" },
    });
    return data as unknown as string; // this will be a string if media format is raw
  } catch (err) {
    console.error(err);
    return null;
  }
}

export function parseYaml(data: null | string) {
  try {
    if (data) {
      const parsedData = YAML.parse(data);
      return { yaml: parsedData ?? null, errors: null };
    }
  } catch (error) {
    console.error("Error parsing YAML", error);
    return { errors: [error] as YAMLError[], yaml: null };
  }
  return { yaml: null, errors: null };
}
