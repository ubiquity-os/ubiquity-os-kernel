import { GitHubContext } from "../github-context";
import { CONFIG_FULL_PATH, getConfigurationFromRepo } from "../utils/config";
import YAML, { LineCounter, Node, YAMLError } from "yaml";
import { ValueError } from "typebox-validators";
import { dispatchWorker, dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import { PluginInput, PluginOutput, pluginOutputSchema } from "../types/plugin";
import { isGithubPlugin } from "../types/plugin-configuration";
import { Value, ValueErrorType } from "@sinclair/typebox/value";
import { StateValidation, stateValidationSchema } from "../types/state-validation-payload";

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
  const { octokit, payload } = context;
  const { client_payload } = payload;
  let pluginOutput: PluginOutput;
  let stateValidation: StateValidation;

  try {
    pluginOutput = Value.Decode(pluginOutputSchema, client_payload);
  } catch (error) {
    console.error("[handleActionValidationWorkflowCompleted]: Cannot decode plugin output", error);
    throw error;
  }

  const state = await context.eventHandler.pluginChainState.get(pluginOutput.state_id);

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

  const { rawData, path } = state.additionalProperties ?? {};
  try {
    if (errors.length) {
      const body = [];
      console.log("+++", JSON.stringify(state, null, 2));
      body.push(`@${state.eventPayload.sender?.login} Configuration is invalid.\n`);
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
      await octokit.rest.repos.createCommitComment({
        owner: state.eventPayload.repository.owner.login,
        repo: state.eventPayload.repository.name,
        commit_sha: state.eventPayload.after as string,
        body: body.join(""),
      });
    }
  } catch (e) {
    console.error("handleActionValidationWorkflowCompleted", e);
  }
}

export default async function handlePushEvent(context: GitHubContext<"push">) {
  const { octokit, payload, eventHandler } = context;
  const { repository, commits, after } = payload;

  const didConfigurationFileChange = commits.some((commit) => commit.modified?.includes(CONFIG_FULL_PATH) || commit.added?.includes(CONFIG_FULL_PATH));

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
            const { plugin, with: args } = uses[j];
            const isGithubPluginObject = isGithubPlugin(plugin);
            const stateId = crypto.randomUUID();
            const token = payload.installation ? await eventHandler.getToken(payload.installation.id) : "";
            const ref = isGithubPluginObject ? (plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo))) : plugin;
            const inputs = new PluginInput(context.eventHandler, stateId, context.key, payload, args, token, ref);

            if (!isGithubPluginObject) {
              const response = await dispatchWorker(`${plugin}/manifest`, await inputs.getWorkerInputs());
              if (response.errors) {
                errors.push(...response.errors.map((err) => ({ ...err, path: `plugins/${i}/uses/${j}/with${err.path}` })));
              }
            } else {
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
              await dispatchWorkflow(context, {
                owner: plugin.owner,
                repository: plugin.repo,
                workflowId: "validate-schema.yml",
                ref: plugin.ref,
                inputs: inputs.getWorkflowInputs(),
              });
            }
          }
        }
      } else if (configurationErrors) {
        errors.push(...configurationErrors);
      }
      try {
        if (errors.length) {
          const body = [];
          body.push(`@${payload.sender?.login} Configuration is invalid.\n`);
          body.push(...constructErrorBody(errors, rawData, repository, after));
          await octokit.rest.repos.createCommitComment({
            owner: repository.owner.login,
            repo: repository.name,
            commit_sha: after,
            body: body.join(""),
          });
        }
      } catch (e) {
        console.error("handlePushEventError", e);
      }
    }
  }
}
