import { Value } from "@sinclair/typebox/value";
import { GitHubContext } from "../github-context";
import YAML from "yaml";
import { Config, configSchema } from "../types/config";
import { expressionRegex } from "../types/plugin";
import { eventNames } from "../types/webhook-events";

const UBIQUIBOT_CONFIG_FULL_PATH = ".github/ubiquibot-config.yml";

export async function getConfig(context: GitHubContext): Promise<Config | null> {
  const payload = context.payload;
  if (!("repository" in payload) || !payload.repository) throw new Error("Repository is not defined");

  const _repoConfig = parseYaml(
    await download({
      context,
      repository: payload.repository.name,
      owner: payload.repository.owner.login,
    })
  );
  if (!_repoConfig) return null;

  let config: Config;
  try {
    config = Value.Decode(configSchema, Value.Default(configSchema, _repoConfig));
  } catch (error) {
    console.error("Error decoding config", error);
    return null;
  }

  checkPluginChains(config);

  return config;
}

function checkPluginChains(config: Config) {
  for (const eventName of eventNames) {
    const plugins = config.plugins[eventName];
    for (const plugin of plugins) {
      const allIds = checkPluginChainUniqueIds(plugin);
      checkPluginChainExpressions(plugin, allIds);
    }
  }
}

function checkPluginChainUniqueIds(plugin: Config["plugins"]["*"][0]) {
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

function checkPluginChainExpressions(plugin: Config["plugins"]["*"][0], allIds: Set<string>) {
  const calledIds = new Set<string>();
  for (const use of plugin.uses) {
    if (!use.id) continue;
    for (const key in use.with) {
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
      path: UBIQUIBOT_CONFIG_FULL_PATH,
      mediaType: { format: "raw" },
    });
    return data as unknown as string; // this will be a string if media format is raw
  } catch (err) {
    return null;
  }
}

export function parseYaml(data: null | string) {
  try {
    if (data) {
      const parsedData = YAML.parse(data);
      return parsedData ?? null;
    }
  } catch (error) {
    console.error("Error parsing YAML", error);
  }
  return null;
}
