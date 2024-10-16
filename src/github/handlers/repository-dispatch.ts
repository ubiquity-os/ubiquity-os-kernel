import { Value } from "@sinclair/typebox/value";
import { GitHubContext } from "../github-context";
import { expressionRegex, PluginChainState, PluginInput, pluginOutputSchema } from "../types/plugin";
import { isGithubPlugin } from "../types/plugin-configuration";
import { dispatchWorker, dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";

export async function repositoryDispatch(context: GitHubContext<"repository_dispatch">) {
  console.log("Repository dispatch event received", context.payload.client_payload);

  if (context.payload.action !== "return-data-to-ubiquity-os-kernel") {
    console.log("Skipping non UbiquityOS event");
    return;
  }

  let pluginOutput;

  try {
    pluginOutput = Value.Decode(pluginOutputSchema, context.payload.client_payload);
  } catch (error) {
    console.error("Cannot decode plugin output", error);
    throw error;
  }
  console.log("Plugin output", pluginOutput);

  const state = await context.eventHandler.pluginChainState.get(pluginOutput.state_id);
  if (!state) {
    console.error("No state found for plugin chain");
    return;
  }

  if (!("installation" in state.eventPayload) || state.eventPayload.installation?.id === undefined) {
    console.error("No installation found");
    return;
  }

  const currentPlugin = state.pluginChain[state.currentPlugin];
  if (
    isGithubPlugin(currentPlugin.plugin) &&
    (currentPlugin.plugin.owner !== context.payload.repository.owner.login || currentPlugin.plugin.repo !== context.payload.repository.name)
  ) {
    console.error("Plugin chain state does not match payload");
    return;
  }
  state.outputs[state.currentPlugin] = pluginOutput;
  console.log("State", state);

  const nextPlugin = state.pluginChain[state.currentPlugin + 1];
  if (!nextPlugin) {
    console.log("No more plugins to call");
    await context.eventHandler.pluginChainState.put(pluginOutput.state_id, state);
    return;
  }
  console.log("Dispatching next plugin", nextPlugin);

  const token = await context.eventHandler.getToken(state.eventPayload.installation.id);
  const settings = findAndReplaceExpressions(nextPlugin.with, state);
  let ref: string;
  if (isGithubPlugin(nextPlugin.plugin)) {
    const defaultBranch = await getDefaultBranch(context, nextPlugin.plugin.owner, nextPlugin.plugin.repo);
    ref = nextPlugin.plugin.ref ?? defaultBranch;
  } else {
    ref = nextPlugin.plugin;
  }
  const inputs = new PluginInput(context.eventHandler, pluginOutput.state_id, state.eventName, state.eventPayload, settings, token, ref);

  state.currentPlugin++;
  state.inputs[state.currentPlugin] = inputs;
  await context.eventHandler.pluginChainState.put(pluginOutput.state_id, state);

  if (isGithubPlugin(nextPlugin.plugin)) {
    await dispatchWorkflow(context, {
      owner: nextPlugin.plugin.owner,
      repository: nextPlugin.plugin.repo,
      ref: nextPlugin.plugin.ref,
      workflowId: nextPlugin.plugin.workflowId,
      inputs: await inputs.getWorkflowInputs(),
    });
  } else {
    await dispatchWorker(nextPlugin.plugin, await inputs.getWorkerInputs());
  }
}

function findAndReplaceExpressions(settings: object, state: PluginChainState): Record<string, unknown> {
  const newSettings: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === "string") {
      const matches = value.match(expressionRegex);
      if (!matches) {
        newSettings[key] = value;
        continue;
      }
      const parts = matches[1].split(".");
      newSettings[key] = getPluginInfosFromParts(parts, value, state);
    } else if (typeof value === "object" && value !== null) {
      newSettings[key] = findAndReplaceExpressions(value, state);
    } else {
      newSettings[key] = value;
    }
  }

  return newSettings;
}

function getPluginInfosFromParts(parts: string[], value: string, state: PluginChainState) {
  if (parts.length !== 3) {
    throw new Error(`Invalid expression: ${value}`);
  }
  const pluginId = parts[0];

  if (parts[1] === "output") {
    const outputProperty = parts[2];
    return getPluginOutputValue(state, pluginId, outputProperty);
  } else {
    throw new Error(`Invalid expression: ${value}`);
  }
}

function getPluginOutputValue(state: PluginChainState, pluginId: string, outputKey: string): unknown {
  const pluginIdx = state.pluginChain.findIndex((plugin) => plugin.id === pluginId);
  if (pluginIdx === -1) {
    throw new Error(`Plugin ${pluginId} not found in the chain`);
  }
  if (pluginIdx > state.currentPlugin) {
    throw new Error(`You cannot use output values from plugin ${pluginId} because it's not been called yet`);
  }

  const outputValue = state.outputs[pluginIdx].output[outputKey];
  if (outputValue === undefined) {
    throw new Error(`Output key '${outputKey}' not found for plugin ${pluginId}`);
  }

  return outputValue;
}
