import { GitHubContext } from "../github-context";
import { CONFIG_FULL_PATH, getConfigurationFromRepo } from "../utils/config";
import YAML, { LineCounter } from "yaml";

export default async function handlePushEvent(context: GitHubContext<"push">) {
  const { octokit, payload } = context;
  const { repository, commits, after } = payload;

  const didConfigurationFileChange = commits.some(
    (commit) => commit.modified?.includes(CONFIG_FULL_PATH) || commit.added?.includes(CONFIG_FULL_PATH) || commit.removed?.includes(CONFIG_FULL_PATH)
  );

  if (didConfigurationFileChange) {
    console.log("Configuration file changed, will run configuration checks.");

    if (repository.owner) {
      const { config, errors, rawData } = await getConfigurationFromRepo(context, repository.name, repository.owner.login);
      if (config) {
        // check each plugin
      }
      try {
        const body = [];

        body.push(`@${payload.sender?.login} Configuration is ${!errors ? "valid" : "invalid"}.\n`);
        console.log("errors detected", errors);
        if (errors) {
          for (const error of errors) {
            if ("linePos" in error) {
              body.push(`https://github.com/${repository.owner.login}/${repository.name}/blob/${after}/${CONFIG_FULL_PATH}#L${4}`);
            } else if (rawData) {
              const lineCounter = new LineCounter();
              const doc = YAML.parseDocument(rawData, { lineCounter });
              const node = doc.getIn(["plugins", 0, "uses", 0, "plugin"], true);
              const linePos = lineCounter.linePos(node.range[0]);
              body.push(`https://github.com/${repository.owner.login}/${repository.name}/blob/${after}/${CONFIG_FULL_PATH}#L${linePos.line}`);
            }
            body.push(`\n\`\`\`\n`);
            body.push(
              `${error.error ? JSON.stringify({ path: error.error.path, value: error.error.value, message: error.error.message }, null, 2) : error.message}`
            );
            body.push(`\n\`\`\`\n`);
          }
        }
        await octokit.rest.repos.createCommitComment({
          owner: repository.owner.login,
          repo: repository.name,
          commit_sha: after,
          body: body.join(""),
        });
      } catch (e) {
        console.error("handlePushEventError", e);
      }
    }
  }
}
