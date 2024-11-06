import { EmitterWebhookEvent as WebhookEvent, EmitterWebhookEventName as WebhookEventName } from "@octokit/webhooks";
import { Logs } from "@ubiquity-os/ubiquity-os-logger";
import { customOctokit } from "./octokit";

export type SupportedEventsU = WebhookEventName;
export type SupportedEvents = {
  [K in SupportedEventsU]: K extends WebhookEventName ? WebhookEvent<K> : never;
};

export interface Context<TConfig = unknown, TEnv = unknown, TSupportedEvents extends SupportedEventsU = WebhookEventName> {
  eventName: TSupportedEvents;
  payload: SupportedEvents[TSupportedEvents]["payload"];
  octokit: InstanceType<typeof customOctokit>;
  config: TConfig;
  env: TEnv;
  logger: Logs;
}
