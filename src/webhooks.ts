import { EmitterWebhookEvent } from "@octokit/webhooks";
import { makeEventKey } from "./webhooks/make-event-key";
import handlers from "./handlers/handlers";

export async function handleGitHubEvent(event: EmitterWebhookEvent) {
  const eventKey = makeEventKey(event);

  console.log(eventKey);
  console.log();
  console.log(event);
  console.log();
  console.log(eventKey);

  switch (eventKey) {
    case "issue_comment.created":
      return handlers.issueCommentCreated(event.payload);
    default:
      return notImplemented(event);
  }
}

function notImplemented(event: EmitterWebhookEvent) {
  console.log(`Not implemented: ${makeEventKey(event)}`);
}
