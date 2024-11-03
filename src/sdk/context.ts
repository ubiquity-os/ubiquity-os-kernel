import { EmitterWebhookEvent as WebhookEvent, EmitterWebhookEventName as WebhookEventName } from "@octokit/webhooks";
import { Logs } from "@ubiquity-os/ubiquity-os-logger";
import { customOctokit } from "./octokit";
import { CommandCall } from "../types/command";

export interface Context<TConfig = unknown, TEnv = unknown, TSupportedEvents extends WebhookEventName = WebhookEventName> {
  eventName: TSupportedEvents;
  payload: {
    [K in TSupportedEvents]: K extends WebhookEventName ? WebhookEvent<K> : never;
  }[TSupportedEvents]["payload"];
  command: CommandCall;
  octokit: InstanceType<typeof customOctokit>;
  config: TConfig;
  env: TEnv;
  logger: Logs;
}
