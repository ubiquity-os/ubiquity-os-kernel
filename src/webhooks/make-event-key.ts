import { EmitterWebhookEvent } from "@octokit/webhooks";
import { GitHubEvent } from "../types/github-events";

export function makeEventKey(event: EmitterWebhookEvent): GitHubEvent {
  const name = event.name;
  if ("action" in event.payload) {
    const action = event.payload.action;
    return `${name}.${action}` as GitHubEvent;
  } else {
    throw new Error("Event payload does not have an action property");
  }
}
