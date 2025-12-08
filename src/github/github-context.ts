import { EmitterWebhookEvent as WebhookEvent, EmitterWebhookEventName as WebhookEventName } from "@octokit/webhooks";
import { ConfigurationHandler } from "@ubiquity-os/plugin-sdk/configuration";
import OpenAI from "openai";
import { logger as pinoLogger } from "../logger/logger";
import { customOctokit } from "./github-client";
import { GitHubEventHandler } from "./github-event-handler";

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
  public llm: string;
  public logger = pinoLogger;
  public configurationHandler: ConfigurationHandler;

  constructor(
    eventHandler: InstanceType<typeof GitHubEventHandler>,
    event: WebhookEvent<TSupportedEvents>,
    octokit: InstanceType<typeof customOctokit>,
    openAi: OpenAI,
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
    this.openAi = openAi;
    this.llm = eventHandler.llm;
    const instigator = "repository" in this.payload ? this.payload.repository?.html_url : undefined;
    this.logger = logger.child({ name: this.key, instigator });
    this.configurationHandler = new ConfigurationHandler(
      {
        debug: (message, metadata) => this.logger.debug(metadata, message),
        error: (message, metadata) => this.logger.error(metadata, message),
        info: (message, metadata) => this.logger.info(metadata, message),
        warn: (message, metadata) => this.logger.warn(metadata, message),
      },
      this.octokit
    );
  }
}

export type SimplifiedContext = Omit<GitHubContext, keyof WebhookEventName>;
