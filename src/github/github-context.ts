import { EmitterWebhookEvent as WebhookEvent, EmitterWebhookEventName as WebhookEventName } from "@octokit/webhooks";
import { customOctokit } from "./github-client";
import { GitHubEventHandler } from "./github-event-handler";
import OpenAI from "openai";
import { VoyageAIClient } from "voyageai";

export class GitHubContext<TSupportedEvents extends WebhookEventName = WebhookEventName> {
  public key: WebhookEventName;
  public name: WebhookEventName;
  public id: string;
  public payload: {
    [K in TSupportedEvents]: K extends WebhookEventName ? WebhookEvent<K> : never;
  }[TSupportedEvents]["payload"];
  public octokit: InstanceType<typeof customOctokit>;
  public eventHandler: InstanceType<typeof GitHubEventHandler>;
  public openAi: OpenAI;
  public voyageAiClient: VoyageAIClient;

  constructor(
    eventHandler: InstanceType<typeof GitHubEventHandler>,
    event: WebhookEvent<TSupportedEvents>,
    octokit: InstanceType<typeof customOctokit>,
    openAi: OpenAI,
    voyageAiClient: VoyageAIClient
  ) {
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
    this.openAi = openAi;
    this.voyageAiClient = voyageAiClient;
  }
}

export type SimplifiedContext = Omit<GitHubContext, keyof WebhookEventName>;
