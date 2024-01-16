import { EmitterWebhookEvent } from "@octokit/webhooks";

export async function handleEvent(event: EmitterWebhookEvent) {
  console.log(event);
}
