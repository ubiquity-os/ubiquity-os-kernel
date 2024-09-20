import { GitHubContext } from "../github-context";
import { CONFIG_FULL_PATH, getConfigurationFromRepo } from "../utils/config";
import YAML, { LineCounter, Node, YAMLError } from "yaml";
import { ValueError } from "typebox-validators";
import { dispatchWorker, dispatchWorkflow } from "../utils/workflow-dispatch";

function constructErrorBody(
  errors: Iterable<ValueError> | ValueError[] | YAML.YAMLError[],
  rawData: string | null,
  repository: GitHubContext<"push">["payload"]["repository"],
  after: string
) {
  const body = [];
  if (errors) {
    for (const error of errors) {
      body.push("> [!CAUTION]\n");
      if (error instanceof YAMLError) {
        body.push(`> https://github.com/${repository.owner?.login}/${repository.name}/blob/${after}/${CONFIG_FULL_PATH}#L${error.linePos?.[0].line}`);
      } else if (rawData) {
        const lineCounter = new LineCounter();
        const doc = YAML.parseDocument(rawData, { lineCounter });
        const path = error.path.split("/").filter((o) => o);
        // .slice(0, -1); TODO: depending if missing, slice or not
        console.log("+++ path", path);
        const node = doc.getIn(path, true) as Node;
        const linePosStart = lineCounter.linePos(node.range?.[0] || 0);
        body.push(`> https://github.com/${repository.owner?.login}/${repository.name}/blob/${after}/${CONFIG_FULL_PATH}#L${linePosStart.line}`);
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
      body.push(`\n> \`\`\`\n\n`);
    }
  }
  return body;
}

// TODO: store id within KV and get payload from there
export async function handleActionValidationWorkflowCompleted(context: GitHubContext<"repository_dispatch">) {
  const { octokit, payload } = context;
  const { repository, client_payload } = payload;

  if (client_payload && "output" in client_payload) {
    const { rawData } = await getConfigurationFromRepo(context, repository.name, repository.owner.login);
    const result = JSON.parse(client_payload.output);
    console.log("Received Action output result for validation, will process.");
    console.log(result);
    const errors = result.errors;
    try {
      const body = [];
      body.push(`@${payload.sender?.login} Configuration is ${!errors.length ? "valid" : "invalid"}.\n`);
      if (errors.length) {
        body.push(...constructErrorBody(errors, rawData, repository, result.after));
      }
      console.log("+))) creating commit comment", {
        owner: repository.owner.login,
        repo: repository.name,
        commit_sha: result.after,
        body: body.join(""),
      });
      await octokit.rest.repos.createCommitComment({
        owner: repository.owner.login,
        repo: repository.name,
        commit_sha: result.after,
        body: body.join(""),
      });
    } catch (e) {
      console.error("handleActionValidationWorkflowCompleted", e);
    }
  }
}

export default async function handlePushEvent(context: GitHubContext<"push">) {
  const { octokit, payload } = context;
  const { repository, commits, after } = payload;

  const didConfigurationFileChange = commits.some(
    (commit) => commit.modified?.includes(CONFIG_FULL_PATH) || commit.added?.includes(CONFIG_FULL_PATH) || commit.removed?.includes(CONFIG_FULL_PATH)
  );

  if (didConfigurationFileChange) {
    console.log("Configuration file changed, will run configuration checks.");

    if (repository.owner) {
      const { config, errors: configurationErrors, rawData } = await getConfigurationFromRepo(context, repository.name, repository.owner.login);
      const errors = [];
      // TODO test unreachable endpoints
      if (!configurationErrors && config) {
        for (let i = 0; i < config.plugins.length; ++i) {
          const { uses } = config.plugins[i];
          for (let j = 0; j < uses.length; ++j) {
            const use = uses[j];
            if (typeof use.plugin === "string") {
              const response = await dispatchWorker(`${use.plugin}/manifest`, { settings: use.with });
              if (response.errors) {
                errors.push(...response.errors.map((err) => ({ ...err, path: `plugins/${i}/uses/${j}/with${err.path}` })));
              }
            } else {
              await dispatchWorkflow(context, {
                owner: use.plugin.owner,
                ref: use.plugin.ref,
                repository: use.plugin.repo,
                workflowId: "validate-schema.yml",
                inputs: { settings: JSON.stringify(use.with), after },
              });
            }
          }
        }
      } else if (configurationErrors) {
        errors.push(...configurationErrors);
      }
      try {
        const body = [];
        body.push(`@${payload.sender?.login} Configuration is ${!errors.length ? "valid" : "invalid"}.\n`);
        if (errors.length) {
          body.push(...constructErrorBody(errors, rawData, repository, after));
        }
        console.log("))) creating commit comment", {
          owner: repository.owner.login,
          repo: repository.name,
          commit_sha: after,
          body: body.join(""),
        });
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
