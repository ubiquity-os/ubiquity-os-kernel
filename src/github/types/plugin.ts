import { EmitterWebhookEvent, EmitterWebhookEventName } from "@octokit/webhooks";
import { compressString } from "@ubiquity-os/plugin-sdk/compression";
import { CommandCall } from "../../types/command";
import { GitHubEventHandler } from "../github-event-handler";

export class PluginInput<T extends EmitterWebhookEventName = EmitterWebhookEventName> {
  public eventHandler: GitHubEventHandler;
  public stateId: string;
  public eventName: T;
  public eventPayload: EmitterWebhookEvent<T>["payload"];
  public settings: unknown;
  public authToken: string;
  public ref: string;
  public command: CommandCall;

  constructor(
    eventHandler: GitHubEventHandler,
    stateId: string,
    eventName: T,
    eventPayload: EmitterWebhookEvent<T>["payload"],
    settings: unknown,
    authToken: string,
    ref: string,
    command: CommandCall
  ) {
    this.eventHandler = eventHandler;
    this.stateId = stateId;
    this.eventName = eventName;
    this.eventPayload = eventPayload;
    this.settings = settings;
    this.authToken = authToken;
    this.ref = ref;
    this.command = command;
  }

  public async getInputs() {
    const inputs = {
      stateId: this.stateId,
      eventName: this.eventName,
      eventPayload: compressString(JSON.stringify(this.eventPayload)),
      settings: JSON.stringify(this.settings),
      authToken: this.authToken,
      ref: this.ref,
      command: JSON.stringify(this.command),
    };
    const signature = await this.eventHandler.signPayload(JSON.stringify(inputs));
    return {
      ...inputs,
      signature,
    };
  }
}
