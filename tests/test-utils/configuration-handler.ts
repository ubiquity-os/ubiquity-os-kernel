import { GithubPlugin, PluginConfiguration } from "../../src/github/types/plugin-configuration";

type CreateOptions = {
  configuration?: PluginConfiguration;
  manifests?: Record<string, unknown>;
  getConfiguration?: () => Promise<PluginConfiguration>;
  getManifest?: (plugin: GithubPlugin) => Promise<unknown>;
  getConfigurationFromRepo?: (owner: string, repository: string) => Promise<unknown>;
};

export function createConfigurationHandler(options: CreateOptions = {}) {
  const { configuration, manifests = {}, getConfiguration, getManifest, getConfigurationFromRepo } = options;
  const resolvedConfiguration = configuration ?? { plugins: {} };

  return {
    getConfiguration: getConfiguration ?? (async () => resolvedConfiguration),
    getManifest:
      getManifest ??
      (async (plugin: GithubPlugin) => {
        return manifests[plugin.repo] ?? manifests[`${plugin.owner}/${plugin.repo}`] ?? null;
      }),
    getConfigurationFromRepo:
      getConfigurationFromRepo ??
      (async () => {
        return { config: null, errors: null, rawData: null };
      }),
  };
}
