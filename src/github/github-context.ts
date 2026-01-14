import { EmitterWebhookEvent as WebhookEvent, EmitterWebhookEventName as WebhookEventName } from "@octokit/webhooks";
import { logger as pinoLogger } from "../logger/logger.ts";
import { customOctokit } from "./github-client.ts";
import { GitHubEventHandler } from "./github-event-handler.ts";

export class GitHubContext<TSupportedEvents extends WebhookEventName = WebhookEventName> {
  public key: WebhookEventName;
  public name: WebhookEventName;
  public id: string;
  public payload: {
    [K in TSupportedEvents]: K extends WebhookEventName ? WebhookEvent<K> : never;
  }[TSupportedEvents]["payload"];
  public octokit: InstanceType<typeof customOctokit>;
  public eventHandler: InstanceType<typeof GitHubEventHandler>;
  public llm: string;
  public logger = pinoLogger;

  constructor(
    eventHandler: InstanceType<typeof GitHubEventHandler>,
    event: WebhookEvent<TSupportedEvents>,
    octokit: InstanceType<typeof customOctokit>,
    logger: typeof pinoLogger
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
    this.llm = eventHandler.llm;
    const instigator = "repository" in this.payload ? this.payload.repository?.html_url : undefined;
    this.logger = logger.child({ name: this.key, instigator });
  }
}

export type SimplifiedContext = Omit<GitHubContext, keyof WebhookEventName>;
