import { EmitterWebhookEvent } from "@octokit/webhooks";
import { GitHubContext } from "../github-context";
import { GitHubEventHandler } from "../github-event-handler";
import { getConfig } from "../utils/config";
import issueCommentCreated from "./issue-comment-created";
import { repositoryDispatch } from "./repository-dispatch";
import { dispatchWorker, dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import { PluginInput } from "../types/plugin";
import { isGithubPlugin, PluginConfiguration } from "../types/plugin-configuration";
import { getManifest, getPluginsForEvent } from "../utils/plugins";
import handlePushEvent from "./push-event";

function tryCatchWrapper(fn: (event: EmitterWebhookEvent) => unknown) {
  return async (event: EmitterWebhookEvent) => {
    try {
      await fn(event);
    } catch (error) {
      console.error("Error in event handler", error);
    }
  };
}

export function bindHandlers(eventHandler: GitHubEventHandler) {
  eventHandler.on("repository_dispatch", repositoryDispatch);
  eventHandler.on("issue_comment.created", issueCommentCreated);
  eventHandler.on("push", handlePushEvent);
  eventHandler.onAny(tryCatchWrapper((event) => handleEvent(event, eventHandler))); // onAny should also receive GithubContext but the types in octokit/webhooks are weird
}

export async function shouldSkipPlugin(context: GitHubContext, pluginChain: PluginConfiguration["plugins"][0]) {
  if (pluginChain.skipBotEvents && "sender" in context.payload && context.payload.sender?.type === "Bot") {
    console.log("Skipping plugin chain because sender is a bot");
    return true;
  }
  const manifest = await getManifest(context, pluginChain.uses[0].plugin);
  if (
    context.key === "issue_comment.created" &&
    manifest?.commands &&
    Object.keys(manifest.commands).length &&
    !Object.keys(manifest.commands).some(
      (command) => "comment" in context.payload && typeof context.payload.comment !== "string" && context.payload.comment?.body.trim().startsWith(`/${command}`)
    )
  ) {
    console.log(`Skipping plugin chain ${manifest.name} because command does not match.`, manifest.commands);
    return true;
  }
  return false;
}

async function handleEvent(event: EmitterWebhookEvent, eventHandler: InstanceType<typeof GitHubEventHandler>) {
  const context = eventHandler.transformEvent(event);

  const config = await getConfig(context);

  if (!config) {
    console.log("No config found");
    return;
  }

  if (!("installation" in event.payload) || event.payload.installation?.id === undefined) {
    console.log("No installation found");
    return;
  }

  const pluginChains = getPluginsForEvent(config.plugins, context.key);

  if (pluginChains.length === 0) {
    console.log(`No handler found for event ${event.name}`);
    return;
  }

  for (const pluginChain of pluginChains) {
    if (await shouldSkipPlugin(context, pluginChain)) {
      continue;
    }

    // invoke the first plugin in the chain
    const { plugin, with: settings } = pluginChain.uses[0];
    const isGithubPluginObject = isGithubPlugin(plugin);
    console.log(`Calling handler ${JSON.stringify(plugin)} for event ${event.name}`);

    const stateId = crypto.randomUUID();

    const state = {
      eventId: context.id,
      eventName: context.key,
      eventPayload: event.payload,
      currentPlugin: 0,
      pluginChain: pluginChain.uses,
      outputs: new Array(pluginChain.uses.length),
      inputs: new Array(pluginChain.uses.length),
    };

    const ref = isGithubPluginObject ? (plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo))) : plugin;
    const token = await eventHandler.getToken(event.payload.installation.id);
    const inputs = new PluginInput(context.eventHandler, stateId, context.key, event.payload, settings, token, ref);

    state.inputs[0] = inputs;
    await eventHandler.pluginChainState.put(stateId, state);

    // We wrap the dispatch so a failing plugin doesn't break the whole execution
    try {
      if (!isGithubPluginObject) {
        await dispatchWorker(plugin, await inputs.getWorkerInputs());
      } else {
        await dispatchWorkflow(context, {
          owner: plugin.owner,
          repository: plugin.repo,
          workflowId: plugin.workflowId,
          ref: plugin.ref,
          inputs: await inputs.getWorkflowInputs(),
        });
      }
    } catch (e) {
      console.error(`An error occurred while processing the plugin chain, will skip plugin ${JSON.stringify(plugin)}`, e);
    }
  }
}
