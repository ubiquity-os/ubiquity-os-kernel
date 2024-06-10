import { EmitterWebhookEvent as WebhookEvent, EmitterWebhookEventName as WebhookEventName } from "@octokit/webhooks";
import { customOctokit } from "./github-client";
import { GitHubEventHandler } from "./github-event-handler";

export type SupportedEventsU = WebhookEventName;

export type SupportedEvents = {
  [K in SupportedEventsU]: K extends WebhookEventName ? WebhookEvent<K> : never;
};

export class GitHubContext<T extends SupportedEventsU = SupportedEventsU, TU extends SupportedEvents[T] = SupportedEvents[T]> {
  public key: WebhookEventName;
  public name: WebhookEventName;
  public id: string;
  public payload: TU["payload"];
  public octokit: InstanceType<typeof customOctokit>;
  public eventHandler: InstanceType<typeof GitHubEventHandler>;

  constructor(eventHandler: InstanceType<typeof GitHubEventHandler>, event: TU, octokit: InstanceType<typeof customOctokit>) {
    this.eventHandler = eventHandler;
    this.name = event.name;
    this.id = event.id;
    this.payload = event.payload;
    if ("action" in this.payload) {
      this.key = `${this.name}.${this.payload.action}` as WebhookEventName;
    } else {
      this.key = this.name;
    }
    this.octokit = octokit;
  }
}

export type SimplifiedContext = Omit<GitHubContext, keyof WebhookEventName>;
