import { EmitterWebhookEvent, EmitterWebhookEventName } from "@octokit/webhooks";
import { GitHubEventHandler } from "../github-event-handler";
import { getConfig } from "../utils/config";
import { issueCommentCreated } from "./issue-comment/created";
import { repositoryDispatch } from "./repository-dispatch";
import { dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";

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
  eventHandler.onAny(tryCatchWrapper((event) => handleEvent(event, eventHandler)));
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

  const pluginChains = config.plugins[context.key];

  if (pluginChains.length === 0) {
    console.log(`No handler found for event ${event.name}`);
    return;
  }

  for (const pluginChain of pluginChains) {
    // invoke the first plugin in the chain
    const { plugin, with: settings } = pluginChain.uses[0];
    console.log(`Calling handler for event ${event.name}`);

    const id = crypto.randomUUID();
    await eventHandler.pluginChainState.put(id, {
      currentPlugin: 0,
      pluginChain: pluginChain.uses,
    });

    const ref = plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo));
    const token = await eventHandler.getToken(event.payload.installation.id);
    const inputs = new DelegatedComputeInputs(id, context.key, event, settings, token, ref);

    await dispatchWorkflow(context, {
      owner: plugin.owner,
      repository: plugin.repo,
      workflowId: plugin.workflowId,
      ref: plugin.ref,
      inputs: inputs.getInputs(),
    });
  }
}

class DelegatedComputeInputs<T extends EmitterWebhookEventName = EmitterWebhookEventName> {
  public id: string;
  public eventName: T;
  public event: EmitterWebhookEvent<T>;
  public settings: unknown;
  public authToken: string;
  public ref: string;

  constructor(id: string, eventName: T, event: EmitterWebhookEvent<T>, settings: unknown, authToken: string, ref: string) {
    this.id = id;
    this.eventName = eventName;
    this.event = event;
    this.settings = settings;
    this.authToken = authToken;
    this.ref = ref;
  }

  public getInputs() {
    return {
      id: this.id,
      eventName: this.eventName,
      event: JSON.stringify(this.event),
      settings: JSON.stringify(this.settings),
      authToken: this.authToken,
      ref: this.ref,
    };
  }
}
