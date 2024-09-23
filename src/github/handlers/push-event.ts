import { GitHubContext } from "../github-context";
import { CONFIG_FULL_PATH, getConfigurationFromRepo } from "../utils/config";
import YAML, { LineCounter, Node, YAMLError } from "yaml";
import { ValueError } from "typebox-validators";
import { dispatchWorker, dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import { PluginChainState, PluginInput, PluginOutput, pluginOutputSchema } from "../types/plugin";
import { isGithubPlugin, PluginConfiguration } from "../types/plugin-configuration";
import { Value, ValueErrorType } from "@sinclair/typebox/value";
import { pluginValidationResponseSchema, StateValidation, stateValidationSchema } from "../types/state-validation-payload";

function constructErrorBody(
  errors: Iterable<ValueError> | (YAML.YAMLError | ValueError)[],
  rawData: string | null,
  repository: GitHubContext<"push">["payload"]["repository"],
  after: string
) {
  const body = [];
  if (errors) {
    for (const error of errors) {
      body.push("> [!CAUTION]\n");
      if (error instanceof YAMLError) {
        body.push(`> https://github.com/${repository.owner?.login}/${repository.name}/blob/${after}/${CONFIG_FULL_PATH}#L${error.linePos?.[0].line || 0}`);
      } else if (rawData) {
        const lineCounter = new LineCounter();
        const doc = YAML.parseDocument(rawData, { lineCounter });
        const path = error.path.split("/").filter((o) => o);
        if (error.type === ValueErrorType.ObjectRequiredProperty) {
          path.splice(path.length - 1, 1);
        }
        const node = doc.getIn(path, true) as Node;
        const linePosStart = lineCounter.linePos(node?.range?.[0] || 0);
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

export async function handleActionValidationWorkflowCompleted(context: GitHubContext<"repository_dispatch">) {
  const { payload } = context;
  const { client_payload } = payload;
  let pluginOutput: PluginOutput;
  let stateValidation: StateValidation;

  try {
    pluginOutput = Value.Decode(pluginOutputSchema, client_payload);
  } catch (error) {
    console.error("[handleActionValidationWorkflowCompleted]: Cannot decode plugin output", error);
    throw error;
  }

  const state = (await context.eventHandler.pluginChainState.get(pluginOutput.state_id)) as PluginChainState<"push">;

  if (!state) {
    console.error(`[handleActionValidationWorkflowCompleted]: No state found for plugin chain ${pluginOutput.state_id}`);
    return;
  }

  console.log("Received Action output result for validation, will process.", pluginOutput.output);

  const errors = pluginOutput.output.errors as ValueError[];
  try {
    stateValidation = Value.Decode(stateValidationSchema, state.additionalProperties);
  } catch (e) {
    console.error(`[handleActionValidationWorkflowCompleted]: Cannot decode state properties`);
    throw e;
  }
  if (!stateValidation) {
    console.error(`[handleActionValidationWorkflowCompleted]: State validation is invalid for ${pluginOutput.state_id}`);
    return;
  }

  const { rawData, path } = stateValidation;
  try {
    if (errors.length && state.eventPayload.repository.owner) {
      const body = [];
      if (errors.length) {
        body.push(
          ...constructErrorBody(
            errors.map((err) => ({ ...err, path: `${path}${err.path}` })),
            rawData as string,
            state.eventPayload.repository as GitHubContext<"push">["payload"]["repository"],
            state.eventPayload.after as string
          )
        );
      }
      await createCommitComment(
        context,
        {
          owner: state.eventPayload.repository.owner.login,
          repo: state.eventPayload.repository.name,
          commitSha: state.eventPayload.after as string,
          userLogin: state.eventPayload.sender?.login,
        },
        body
      );
    }
  } catch (e) {
    console.error("handleActionValidationWorkflowCompleted", e);
  }
}

async function createCommitComment(
  context: GitHubContext,
  { owner, repo, commitSha, userLogin }: { owner: string; repo: string; commitSha: string; userLogin?: string },
  body: string[]
) {
  const { octokit } = context;

  const commit = (
    await octokit.rest.repos.listCommentsForCommit({
      owner: owner,
      repo: repo,
      commit_sha: commitSha,
    })
  ).data
    .filter((o) => o.user?.type === "Bot")
    .pop();
  if (commit) {
    await octokit.rest.repos.updateCommitComment({
      owner: owner,
      repo: repo,
      commit_sha: commitSha,
      comment_id: commit.id,
      body: `${commit.body}\n${body.join("")}`,
    });
  } else {
    body.unshift(`@${userLogin} Configuration is invalid.\n`);
    await octokit.rest.repos.createCommitComment({
      owner: owner,
      repo: repo,
      commit_sha: commitSha,
      body: body.join(""),
    });
  }
}

async function checkPluginConfigurations(context: GitHubContext<"push">, config: PluginConfiguration, rawData: string | null) {
  const { payload, eventHandler } = context;
  const errors: (ValueError | YAML.YAMLError)[] = [];

  for (let i = 0; i < config.plugins.length; ++i) {
    const { uses } = config.plugins[i];
    for (let j = 0; j < uses.length; ++j) {
      const { plugin, with: args } = uses[j];
      const isGithubPluginObject = isGithubPlugin(plugin);
      const stateId = crypto.randomUUID();
      const token = payload.installation ? await eventHandler.getToken(payload.installation.id) : "";
      const ref = isGithubPluginObject ? (plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo))) : plugin;
      const inputs = new PluginInput(context.eventHandler, stateId, context.key, payload, args, token, ref);

      if (!isGithubPluginObject) {
        try {
          const response = await dispatchWorker(`${plugin}/manifest`, await inputs.getWorkerInputs());
          const decodedResponse = Value.Decode(pluginValidationResponseSchema, response);
          if (decodedResponse.errors) {
            errors.push(...decodedResponse.errors.map((err) => ({ ...err, path: `plugins/${i}/uses/${j}/with${err.path}` })));
          }
        } catch (e) {
          errors.push({
            path: `plugins/${i}/uses/${j}`,
            message: `Failed to reach plugin endpoint: ${e}`,
            value: plugin,
            type: 0,
            schema: stateValidationSchema,
          });
        }
      } else {
        try {
          await dispatchWorkflow(context, {
            owner: plugin.owner,
            repository: plugin.repo,
            workflowId: "validate-schema.yml",
            ref: plugin.ref,
            inputs: inputs.getWorkflowInputs(),
          });
          await eventHandler.pluginChainState.put(stateId, {
            eventPayload: payload,
            currentPlugin: 0,
            eventId: "",
            eventName: "push",
            inputs: [inputs],
            outputs: new Array(uses.length),
            pluginChain: uses,
            additionalProperties: {
              rawData,
              path: `plugins/${i}/uses/${j}/with`,
            },
          });
        } catch (e) {
          errors.push({
            path: `plugins/${i}/uses/${j}`,
            message: `Failed to reach plugin action: ${e}`,
            value: JSON.stringify(plugin),
            type: 0,
            schema: stateValidationSchema,
          });
        }
      }
    }
  }
  return errors;
}

export default async function handlePushEvent(context: GitHubContext<"push">) {
  const { payload } = context;
  const { repository, commits, after } = payload;

  const didConfigurationFileChange = commits.some((commit) => commit.modified?.includes(CONFIG_FULL_PATH) || commit.added?.includes(CONFIG_FULL_PATH));

  if (didConfigurationFileChange) {
    console.log("Configuration file changed, will run configuration checks.");

    if (repository.owner) {
      const { config, errors: configurationErrors, rawData } = await getConfigurationFromRepo(context, repository.name, repository.owner.login);
      const errors: (ValueError | YAML.YAMLError)[] = [];
      if (!configurationErrors && config) {
        errors.push(...(await checkPluginConfigurations(context, config, rawData)));
      } else if (configurationErrors) {
        errors.push(...configurationErrors);
      }
      try {
        if (errors.length) {
          const body = [];
          body.push(...constructErrorBody(errors, rawData, repository, after));
          await createCommitComment(
            context,
            {
              owner: repository.owner.login,
              repo: repository.name,
              commitSha: after,
              userLogin: payload.sender?.login,
            },
            body
          );
        }
      } catch (e) {
        console.error("handlePushEventError", e);
      }
    }
  }
}
