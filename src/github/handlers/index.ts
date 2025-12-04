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
  eventHandler.on("issue_comment.created", issueCommentCreated);
  eventHandler.on("push", handlePushEvent);
  eventHandler.onAny(tryCatchWrapper((event) => handleEvent(event, eventHandler), eventHandler.logger)); // onAny should also receive GithubContext but the types in octokit/webhooks are weird
}

async function handleEvent(event: EmitterWebhookEvent, eventHandler: InstanceType<typeof GitHubEventHandler>) {
  const context = eventHandler.transformEvent(event);

  const config = await getConfig(context);

  if (!config) {
    context.logger.debug("No configuration was found");
    return;
  }

  if (!("installation" in event.payload) || event.payload.installation?.id === undefined) {
    context.logger.warn("No installation found");
    return;
  }

  const resolvedPlugins = await getPluginsForEvent(context, config.plugins, context.key);

  if (resolvedPlugins.length === 0) {
    context.logger.debug("No handler found for event");
    return;
  }

  context.logger.info({ plugins: resolvedPlugins.map((plugin) => plugin.key) }, "Will call plugins for event");

  for (const pluginEntry of resolvedPlugins) {
    const plugin = pluginEntry.target;
    const settings = pluginEntry.settings;
    const isGithubPluginObject = isGithubPlugin(plugin);
    context.logger.debug({ plugin: pluginEntry.key }, "Calling handler for event");

    const stateId = crypto.randomUUID();
    const ref = isGithubPluginObject ? (plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo))) : plugin;
    const token = await eventHandler.getToken(event.payload.installation.id);
    const inputs = new PluginInput(context.eventHandler, stateId, context.key, event.payload, settings?.with, token, ref, null);

    // We wrap the dispatch so a failing plugin doesn't break the whole execution
    try {
      context.logger.debug({ plugin: pluginEntry.key }, "Dispatching event");
      if (!isGithubPluginObject) {
        await dispatchWorker(plugin, await inputs.getInputs());
      } else {
        await dispatchWorkflow(context, {
          owner: plugin.owner,
          repository: plugin.repo,
          workflowId: plugin.workflowId,
          ref,
          inputs: await inputs.getInputs(),
        });
      }
      context.logger.debug({ plugin: pluginEntry.key }, "Event dispatched");
    } catch (e) {
      context.logger.error({ plugin: pluginEntry.key, err: e }, "Error processing plugin; skipping");
    }
  }
}
