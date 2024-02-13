import { EmitterWebhookEvent } from "@octokit/webhooks";
import { GitHubEventHandler } from "../github-event-handler";
import { getConfig } from "../utils/config";
import { issueCommentCreated } from "./issue-comment/created";
import { repositoryDispatch } from "./repository-dispatch";
import { dispatchWorkflow } from "../utils/workflow-dispatch";

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

  const handler = config.handlers.events[context.key];

  if (handler.length === 0) {
    console.log(`No handler found for event ${event.name}`);
    return;
  }

  for (const { workflow, settings } of handler) {
    console.log(`Calling handler for event ${event.name} and workflow ${workflow}`);

    await dispatchWorkflow(context, {
      owner: workflow.owner,
      repository: workflow.repository,
      workflowId: workflow.workflowId,
      ref: workflow.branch,
      inputs: {
        event: JSON.stringify(event),
        settings: JSON.stringify(settings),
      },
    });
  }
}
