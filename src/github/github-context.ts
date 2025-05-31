import { EmitterWebhookEvent as WebhookEvent, EmitterWebhookEventName as WebhookEventName } from "@octokit/webhooks";
import { customOctokit } from "./github-client";
import { GitHubEventHandler } from "./github-event-handler";
import OpenAI from "openai";
import { Logs, LOG_LEVEL } from "@ubiquity-os/ubiquity-os-logger";
import { CommentHandler } from "@ubiquity-os/plugin-sdk";
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
  public logger: Logs;
  public commentHandler: CommentHandler;

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
    this.logger = new Logs(LOG_LEVEL.INFO);
    this.octokit = octokit;
    this.openAi = openAi;
    this.commentHandler = new CommentHandler();
    this.voyageAiClient = voyageAiClient;
  }
}

export type SimplifiedContext = Omit<GitHubContext, keyof WebhookEventName>;
