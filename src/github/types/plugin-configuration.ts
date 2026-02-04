import type { ConfigurationHandler } from "@ubiquity-os/plugin-sdk/configuration";
import { isGithubPlugin } from "@ubiquity-os/plugin-sdk/configuration";

const pluginNameRegex = new RegExp("^([0-9a-zA-Z-._]+)\\/([0-9a-zA-Z-._]+)(?::([0-9a-zA-Z-._]+))?(?:@([0-9a-zA-Z-._]+(?:\\/[0-9a-zA-Z-._]+)*))?$");
const urlRegex = /^https?:\/\/\S+$/;

export type GithubPlugin = {
  owner: string;
  repo: string;
  workflowId: string;
  ref?: string;
};

export type PluginConfiguration = Awaited<ReturnType<ConfigurationHandler["getConfiguration"]>>;
export type PluginSettings = PluginConfiguration["plugins"][string];

export { isGithubPlugin };

export function parsePluginIdentifier(value: string): string | GithubPlugin {
  if (urlRegex.test(value)) {
    return value;
  }
  const matches = value.match(pluginNameRegex);
  if (!matches) {
    throw new Error(`Invalid plugin name: ${value}`);
  }
  return {
    owner: matches[1],
    repo: matches[2],
    workflowId: matches[3] || "compute.yml",
    ref: matches[4] || undefined,
  };
}
