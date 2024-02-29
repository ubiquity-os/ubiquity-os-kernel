import { GitHubContext } from "../github-context";
import { dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import { Value } from "@sinclair/typebox/value";
import { DelegatedComputeInputs, PluginOutput, pluginOutputSchema } from "../types/plugin";

export async function repositoryDispatch(context: GitHubContext<"repository_dispatch">) {
  console.log("Repository dispatch event received", context.payload.client_payload);

  const pluginOutput = context.payload.client_payload as PluginOutput;

  if (!Value.Decode(pluginOutputSchema, pluginOutput)) {
    const errors = [...Value.Errors(pluginOutputSchema, pluginOutput)];
    console.error("Invalid environment variables", errors);
    throw new Error("Invalid environment variables");
  }

  const state = await context.eventHandler.pluginChainState.get(pluginOutput.stateId);
  if (!state) {
    console.error("No state found for plugin chain");
    return;
  }

  if (!("installation" in state.event.payload) || state.event.payload.installation?.id === undefined) {
    console.error("No installation found");
    return;
  }

  const currentPlugin = state.pluginChain[state.currentPlugin];
  if (currentPlugin.plugin.owner !== context.payload.repository.owner.login || currentPlugin.plugin.repo !== context.payload.repository.name) {
    console.error("Plugin chain state does not match payload");
    return;
  }

  const nextPlugin = state.pluginChain[state.currentPlugin];
  if (!nextPlugin) {
    console.log("No more plugins to call");
    return;
  }

  console.log("Dispatching next plugin", nextPlugin);

  const token = await context.eventHandler.getToken(state.event.payload.installation.id);
  const ref = nextPlugin.plugin.ref ?? (await getDefaultBranch(context, nextPlugin.plugin.owner, nextPlugin.plugin.repo));
  const inputs = new DelegatedComputeInputs(pluginOutput.stateId, state.eventName, state.event, nextPlugin.with, token, ref);

  state.outputs[state.currentPlugin] = pluginOutput;
  state.currentPlugin++;
  state.inputs[state.currentPlugin] = inputs;
  await context.eventHandler.pluginChainState.put(pluginOutput.stateId, state);

  await dispatchWorkflow(context, {
    owner: nextPlugin.plugin.owner,
    repository: nextPlugin.plugin.repo,
    ref: nextPlugin.plugin.ref,
    workflowId: nextPlugin.plugin.workflowId,
    inputs: inputs.getInputs(),
  });
}
