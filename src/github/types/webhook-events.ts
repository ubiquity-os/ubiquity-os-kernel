import { emitterEventNames, EmitterWebhookEventName as GitHubEventClassName } from "@octokit/webhooks";

export type EventName = GitHubEventClassName;
export const eventNames: EventName[] = [...emitterEventNames];
