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

  const handler = config.handlers.events[context.key];

  if (handler.length === 0) {
    console.log(`No handler found for event ${event.name}`);
    return;
  }

  for (const { workflow, settings } of handler) {
    console.log(`Calling handler for event ${event.name} and workflow ${workflow}`);

    const ref = workflow.ref ?? (await getDefaultBranch(context, workflow.owner, workflow.repository));
    const token = await eventHandler.getToken(event.payload.installation.id);
    const inputs = new DelegatedComputeInputs(context.key, event, settings, token, ref);

    await dispatchWorkflow(context, {
      owner: workflow.owner,
      repository: workflow.repository,
      workflowId: workflow.workflowId,
      ref: workflow.ref,
      inputs: inputs.getInputs(),
    });
  }
}

class DelegatedComputeInputs<T extends EmitterWebhookEventName = EmitterWebhookEventName> {
  public eventName: T;
  public event: EmitterWebhookEvent<T>;
  public settings: unknown;
  public authToken: string;
  public ref: string;

  constructor(eventName: T, event: EmitterWebhookEvent<T>, settings: unknown, authToken: string, ref: string) {
    this.eventName = eventName;
    this.event = event;
    this.settings = settings;
    this.authToken = authToken;
    this.ref = ref;
  }

  public getInputs() {
    return {
      eventName: this.eventName,
      event: JSON.stringify(this.event),
      settings: JSON.stringify(this.settings),
      authToken: this.authToken,
      ref: this.ref,
    };
  }
}
