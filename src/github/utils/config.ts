import { Value } from "@sinclair/typebox/value";
import { GitHubContext } from "../github-context";
import YAML from "yaml";
import { Config, configSchema } from "../types/config";

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

  try {
    return Value.Decode(configSchema, _repoConfig);
  } catch (error) {
    console.error("Error decoding config", error);
    return null;
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
