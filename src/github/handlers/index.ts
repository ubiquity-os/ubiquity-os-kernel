import { EmitterWebhookEvent } from "@octokit/webhooks";
import { GitHubEventHandler } from "../github-event-handler";
import { getConfig } from "../utils/config";
import { issueCommentCreated } from "./issue-comment/created";
import { repositoryDispatch } from "./repository-dispatch";
import { dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import { DelegatedComputeInputs } from "../types/plugin";

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
  eventHandler.on("issue_comment.created", issueCommentCreated);
  eventHandler.on("repository_dispatch", repositoryDispatch);
  eventHandler.onAny(tryCatchWrapper((event) => handleEvent(event, eventHandler))); // onAny should also receive GithubContext but the types in octokit/webhooks are weird
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

  const pluginChains = config.plugins[context.key].concat(config.plugins["*"]);

  if (pluginChains.length === 0) {
    console.log(`No handler found for event ${event.name}`);
    return;
  }

  for (const pluginChain of pluginChains) {
    if (pluginChain.skipBotEvents && "sender" in event.payload && event.payload.sender?.type === "Bot") {
      continue;
    }
    // invoke the first plugin in the chain
    const { plugin, with: settings } = pluginChain.uses[0];
    console.log(`Calling handler for event ${event.name}`);

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

    const ref = plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo));
    const token = await eventHandler.getToken(event.payload.installation.id);
    const inputs = new DelegatedComputeInputs(stateId, context.key, event.payload, settings, token, ref);

    state.inputs[0] = inputs;
    await eventHandler.pluginChainState.put(stateId, state);

    await dispatchWorkflow(context, {
      owner: plugin.owner,
      repository: plugin.repo,
      workflowId: plugin.workflowId,
      ref: plugin.ref,
      inputs: inputs.getInputs(),
    });
  }
}
