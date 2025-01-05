import { EmitterWebhookEventName } from "@octokit/webhooks";

export const FILTERED_EVENTS: EmitterWebhookEventName[] = ["workflow_job", "workflow_run"];
