import { GitHubContext } from "../github-context";
import { CONFIG_FULL_PATH, getConfigurationFromRepo } from "../utils/config";
import YAML, { LineCounter, Node, YAMLError } from "yaml";

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
      if (!errors && config) {
        // check each plugin
      }
      try {
        const body = [];
        body.push(`@${payload.sender?.login} Configuration is ${!errors ? "valid" : "invalid"}.\n`);
        if (errors) {
          for (const error of errors) {
            body.push("> [!CAUTION]\n");
            if (error instanceof YAMLError) {
              body.push(`> https://github.com/${repository.owner.login}/${repository.name}/blob/${after}/${CONFIG_FULL_PATH}#L${error.linePos?.[0].line}`);
            } else if (rawData) {
              const lineCounter = new LineCounter();
              const doc = YAML.parseDocument(rawData, { lineCounter });
              const path = error.path
                .split("/")
                .filter((o) => o)
                .slice(0, -1);
              const node = doc.getIn(path, true) as Node;
              const linePosStart = lineCounter.linePos(node.range?.[0] || 0);
              body.push(`> https://github.com/${repository.owner.login}/${repository.name}/blob/${after}/${CONFIG_FULL_PATH}#L${linePosStart.line}`);
            }
            const message = [];
            if (error instanceof YAMLError) {
              message.push(error.message);
            } else {
              message.push(`path: ${error.path}\n`);
              message.push(`value: ${error.value}\n`);
              message.push(`message: ${error.message}`);
            }
            body.push(`\n> \`\`\`\n`);
            body.push(`> ${message.join("").replaceAll("\n", "\n> ")}`);
            body.push(`\n> \`\`\`\n`);
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
