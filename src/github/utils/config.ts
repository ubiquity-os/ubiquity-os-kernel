import { Value } from "@sinclair/typebox/value";
import { GitHubContext } from "../github-context";
import { configSchema, PluginConfiguration } from "../types/plugin-configuration";

export const CONFIG_FULL_PATH = ".github/.ubiquity-os.config.yml";
export const DEV_CONFIG_FULL_PATH = ".github/.ubiquity-os.config.dev.yml";
export const CONFIG_ORG_REPO = ".ubiquity-os";

export async function getConfiguration(context: GitHubContext, repository: string, owner: string) {
  return context.configurationHandler.getConfiguration({ owner, repo: repository });
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
  context.logger.debug(
    {
      orgRepo: `${payload.repository.owner.login}/${CONFIG_ORG_REPO}`,
      repo: `${payload.repository.owner.login}/${payload.repository.name}`,
    },
    "Fetching configurations"
  );

  const mergedConfiguration: PluginConfiguration = await getConfiguration(context, payload.repository.name, payload.repository.owner.login);

  context.logger.debug(
    { repo: `${payload.repository.owner.login}/${payload.repository.name}`, plugins: Object.keys(mergedConfiguration.plugins).length },
    "Found plugins enabled"
  );

  return mergedConfiguration;
}
