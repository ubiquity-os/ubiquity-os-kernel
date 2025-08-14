import { EmitterWebhookEvent } from "@octokit/webhooks";
import { logger as pinoLogger } from "../../logger/logger";
import { GitHubEventHandler } from "../github-event-handler";
import { PluginInput } from "../types/plugin";
import { isGithubPlugin } from "../types/plugin-configuration";
import { getConfig } from "../utils/config";
import { getPluginsForEvent } from "../utils/plugins";
import { dispatchWorker, dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import issueCommentCreated from "./issue-comment-created";
import handlePushEvent from "./push-event";
import { repositoryDispatch } from "./repository-dispatch";

function tryCatchWrapper(fn: (event: EmitterWebhookEvent) => unknown, logger: typeof pinoLogger) {
  return async (event: EmitterWebhookEvent) => {
    try {
      await fn(event);
    } catch (error) {
      logger.error({ err: error, event }, "Error in event handler");
    }
  };
}

export function bindHandlers(eventHandler: GitHubEventHandler) {
  eventHandler.on("repository_dispatch", repositoryDispatch);
  eventHandler.on("issue_comment.created", issueCommentCreated);
  eventHandler.on("push", handlePushEvent);
  eventHandler.onAny(tryCatchWrapper((event) => handleEvent(event, eventHandler), eventHandler.logger)); // onAny should also receive GithubContext but the types in octokit/webhooks are weird
}

async function handleEvent(event: EmitterWebhookEvent, eventHandler: InstanceType<typeof GitHubEventHandler>) {
  const context = eventHandler.transformEvent(event);

  const config = await getConfig(context);

  if (!config) {
    context.logger.debug({ event: context.key }, "No config found");
    return;
  }

  if (!("installation" in event.payload) || event.payload.installation?.id === undefined) {
    context.logger.warn({ event: context.key }, "No installation found");
    return;
  }

  const pluginChains = await getPluginsForEvent(context, config.plugins, context.key);

  if (pluginChains.length === 0) {
    context.logger.debug({ event: context.key, name: event.name }, "No handler found for event");
    return;
  }

  context.logger.info({ chain: pluginChains.map((o) => o.uses[0]?.plugin) }, "Will call the plugin chain");

  for (const pluginChain of pluginChains) {
    // invoke the first plugin in the chain
    const { plugin, with: settings } = pluginChain.uses[0];
    const isGithubPluginObject = isGithubPlugin(plugin);
    context.logger.debug({ plugin, event: event.name }, "Calling handler for event");

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
    const inputs = new PluginInput(context.eventHandler, stateId, context.key, event.payload, settings, token, ref, null);

    state.inputs[0] = inputs;
    await eventHandler.pluginChainState.put(stateId, state);

    // We wrap the dispatch so a failing plugin doesn't break the whole execution
    try {
      context.logger.debug({ plugin }, "Dispatching event");
      if (!isGithubPluginObject) {
        await dispatchWorker(plugin, await inputs.getInputs());
      } else {
        await dispatchWorkflow(context, {
          owner: plugin.owner,
          repository: plugin.repo,
          workflowId: plugin.workflowId,
          ref: plugin.ref,
          inputs: await inputs.getInputs(),
        });
      }
      context.logger.debug({ plugin }, "Event dispatched");
    } catch (e) {
      context.logger.error({ plugin, err: e }, "Error processing plugin chain; skipping plugin");
    }
  }
}
