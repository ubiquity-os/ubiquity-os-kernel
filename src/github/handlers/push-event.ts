import { GitHubContext } from "../github-context";
import { CONFIG_FULL_PATH, getConfigurationFromRepo } from "../utils/config";

export default async function handlePushEvent(context: GitHubContext<"push">) {
  const { octokit, payload } = context;
  const { repository, commits, after } = payload;

  const didConfigurationFileChange = commits.some(
    (commit) => commit.modified?.includes(CONFIG_FULL_PATH) || commit.added?.includes(CONFIG_FULL_PATH) || commit.removed?.includes(CONFIG_FULL_PATH)
  );

  if (didConfigurationFileChange) {
    console.log("Configuration file changed, will run configuration checks.");

    if (repository.owner) {
      const configuration = await getConfigurationFromRepo(context, repository.name, repository.owner.login);
      if (configuration) {
        try {
          await octokit.rest.repos.createCommitComment({
            owner: repository.owner.login,
            repo: repository.name,
            commit_sha: after,
            body: "Configuration is valid.",
          });
        } catch (e) {
          console.error(e);
        }
      }
    }
  }
}
