import { EmitterWebhookEvent } from "@octokit/webhooks";
import { GitHubEventClassName } from "../types/github-event-class-names";

export function makeGitHubEventClassName(event: EmitterWebhookEvent): GitHubEventClassName {
  const name = event.name;
  if ("action" in event.payload) {
    const action = event.payload.action;
    return `${name}.${action}` as GitHubEventClassName;
  } else {
    return name;
  }
}
