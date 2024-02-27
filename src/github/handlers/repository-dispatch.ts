import { StaticDecode, Type } from "@sinclair/typebox";
import { GitHubContext } from "../github-context";
import { dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import { Value } from "@sinclair/typebox/value";

export async function repositoryDispatch(context: GitHubContext<"repository_dispatch">) {
  console.log("Repository dispatch event received", context.payload.client_payload);

  const pluginOutput = context.payload.client_payload as PluginOutput;

  if (!Value.Check(pluginOutputSchema, pluginOutput)) {
    const errors = [...Value.Errors(pluginOutputSchema, pluginOutput)];
    console.error("Invalid environment variables", errors);
    throw new Error("Invalid environment variables");
  }

  const state = await context.eventHandler.pluginChainState.get(pluginOutput.id);
  if (!state) {
    console.error("No state found for plugin chain");
    return;
  }

  const currentPlugin = state.pluginChain[state.currentPlugin];
  if (currentPlugin.plugin.owner !== context.payload.repository.owner.login || currentPlugin.plugin.repo !== context.payload.repository.name) {
    console.error("Plugin chain state does not match payload");
    return;
  }

  state.currentPlugin++;
  await context.eventHandler.pluginChainState.put(pluginOutput.id, state);

  const nextPlugin = state.pluginChain[state.currentPlugin];
  if (!nextPlugin) {
    console.log("No more plugins to call");
    return;
  }

  console.log("Dispatching next plugin", nextPlugin);

  const inputs = {
    ...pluginOutput.output,
    id: pluginOutput.id,
    settings: JSON.stringify(nextPlugin.with),
    ref: nextPlugin.plugin.ref ?? (await getDefaultBranch(context, nextPlugin.plugin.owner, nextPlugin.plugin.repo)),
  };

  await dispatchWorkflow(context, {
    owner: nextPlugin.plugin.owner,
    repository: nextPlugin.plugin.repo,
    ref: nextPlugin.plugin.ref,
    workflowId: nextPlugin.plugin.workflowId,
    inputs: inputs,
  });
}

const pluginOutputSchema = Type.Object({
  id: Type.String(),
  owner: Type.String(),
  repo: Type.String(),
  output: Type.Any(),
});

type PluginOutput = StaticDecode<typeof pluginOutputSchema>;
