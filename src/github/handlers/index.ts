import { EmitterWebhookEvent } from "@octokit/webhooks";
import { GitHubEventHandler } from "../github-event-handler";
import { getConfig } from "../utils/config";
import { issueCommentCreated } from "./issue-comment/created";

export function bindHandlers(webhooks: GitHubEventHandler) {
  webhooks.on("issue_comment.created", issueCommentCreated);
  webhooks.onAny(
    tryCatchWrapper(async (event) => {
      const context = webhooks.transformEvent(event);

      const config = await getConfig(context);

      if (!config) {
        console.log("No config found");
        return;
      }

      const handler = config.handlers.events[event.name];

      if (handler.length === 0) {
        console.log(`No handler found for event ${event.name}`);
        return;
      }

      for (const { workflow } of handler) {
        console.log(`Calling handler for event ${event.name} and workflow ${workflow}`);

        // TODO: call the workflow
      }
    })
  );
}

function tryCatchWrapper(fn: (event: EmitterWebhookEvent) => unknown) {
  return async (event: EmitterWebhookEvent) => {
    try {
      await fn(event);
    } catch (error) {
      console.error("Error in event handler", error);
    }
  };
}
