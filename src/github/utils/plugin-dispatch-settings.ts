import { GithubPlugin, isGithubPlugin } from "../types/plugin-configuration";
import { getConfigPathCandidatesForEnvironment } from "./config";

const WORKFLOW_KERNEL_KEY_OVERRIDE_OWNERS = new Set(["ubiquity-os", "ubiquity-os-marketplace", "0x4007-ubiquity-os"]);

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

export async function withKernelContextWorkflowInputsIfNeeded(
  baseInputs: Record<string, string>,
  plugin: string | GithubPlugin,
  getKernelPublicKeyPem: () => Promise<string>
): Promise<Record<string, string>> {
  const inputs = { ...baseInputs };

  if (isGithubPlugin(plugin) && WORKFLOW_KERNEL_KEY_OVERRIDE_OWNERS.has(plugin.owner)) {
    inputs.kernelPublicKey = await getKernelPublicKeyPem();
  }

  return inputs;
}
