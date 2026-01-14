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
  public issueAuthor?: string;
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
    let issueAuthor: string | undefined;
    const payload = this.payload as Record<string, unknown>;
    const comment = payload.comment as { user?: { login: string } } | undefined;
    const issue = payload.issue as { user?: { login: string } } | undefined;
    const pullRequest = payload.pull_request as { user?: { login: string } } | undefined;
    const sender = payload.sender as { login: string } | undefined;

    if (comment?.user?.login) {
      issueAuthor = comment.user.login;
    } else if (issue?.user?.login) {
      issueAuthor = issue.user.login;
    } else if (pullRequest?.user?.login) {
      issueAuthor = pullRequest.user.login;
    } else if (sender?.login) {
      issueAuthor = sender.login;
    }
    this.issueAuthor = issueAuthor;
  }
}

export type SimplifiedContext = Omit<GitHubContext, keyof WebhookEventName>;
