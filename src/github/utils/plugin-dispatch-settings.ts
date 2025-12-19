import { GithubPlugin, isGithubPlugin } from "../types/plugin-configuration";
import { getConfigPathCandidatesForEnvironment } from "./config";

export function buildPluginDispatchSettings(baseSettings: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (baseSettings && typeof baseSettings === "object") return { ...baseSettings };
  return {};
}

export function withKernelContextSettingsIfNeeded(
  baseSettings: Record<string, unknown> | null | undefined,
  plugin: string | GithubPlugin,
  environment: string
): Record<string, unknown> {
  const settings = buildPluginDispatchSettings(baseSettings);

  if (isGithubPlugin(plugin) && plugin.repo === "command-config") {
    settings.environment = environment;
    settings.configPathCandidates = getConfigPathCandidatesForEnvironment(environment);
  }

  return settings;
}
