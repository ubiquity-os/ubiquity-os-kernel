import { EmitterWebhookEvent } from "@octokit/webhooks";
import { makeEventKey } from "./webhooks/make-event-key";

export async function handleEvent(event: EmitterWebhookEvent) {
  const eventKey = makeEventKey(event);

  console.log(eventKey);
  console.log();
  console.log(event);
  console.log();
  console.log(eventKey);

  switch (eventKey) {
    case "issues.opened":
      return notImplemented(event);
    case "issues.closed":
      return notImplemented(event);
    case "issues.reopened":
      return notImplemented(event);
    case "pull_request.opened":
      return notImplemented(event);
    default:
      return notImplemented(event);
  }
}

function notImplemented(event: EmitterWebhookEvent) {
  console.log(`Not implemented: ${makeEventKey(event)}`);
}
