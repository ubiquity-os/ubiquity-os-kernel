import { EmitterWebhookEvent } from "@octokit/webhooks";
import handlers from "./handlers/handlers";
import { makeEventKey } from "./webhooks/make-event-key";

export async function handleGitHubEvent(event: EmitterWebhookEvent) {
  const eventKey = makeEventKey(event);
  const handler = handlers[eventKey];
  if (handler) {
    return handler(event);
  } else {
    return notImplemented(event);
  }
}

function notImplemented(event: EmitterWebhookEvent) {
  console.log(`Not implemented: ${event.name}`);
}
