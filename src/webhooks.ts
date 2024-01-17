import { EmitterWebhookEvent } from "@octokit/webhooks";
import { handlers } from "./handlers/handlers";
import { makeGitHubEventClassName } from "./webhooks/make-github-event-class-name";

export async function handleGitHubEvent(event: EmitterWebhookEvent) {
  const gitHubEventKey = makeGitHubEventClassName(event);
  const handler = handlers[gitHubEventKey];
  if (handler) {
    return await handler(event.payload);
  } else {
    return notImplemented(event);
  }
}

function notImplemented(event: EmitterWebhookEvent) {
  console.log(`Not implemented: ${event.name}`);
}
