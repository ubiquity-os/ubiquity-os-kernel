import { EmitterWebhookEvent as WebhookEvent, EmitterWebhookEventName as WebhookEventName } from "@octokit/webhooks";
import { customOctokit } from "./octokit";

export interface Context<TConfig = unknown, TEnv = unknown, TSupportedEvents extends WebhookEventName = WebhookEventName> {
  eventName: TSupportedEvents;
  payload: {
    [K in TSupportedEvents]: K extends WebhookEventName ? WebhookEvent<K> : never;
  }[TSupportedEvents]["payload"];
  octokit: InstanceType<typeof customOctokit>;
  config: TConfig;
  env: TEnv;
  logger: {
    fatal: (message: unknown, ...optionalParams: unknown[]) => void;
    error: (message: unknown, ...optionalParams: unknown[]) => void;
    warn: (message: unknown, ...optionalParams: unknown[]) => void;
    info: (message: unknown, ...optionalParams: unknown[]) => void;
    debug: (message: unknown, ...optionalParams: unknown[]) => void;
  };
}
