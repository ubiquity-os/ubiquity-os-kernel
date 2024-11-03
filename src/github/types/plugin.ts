import { EmitterWebhookEvent, EmitterWebhookEventName } from "@octokit/webhooks";
import { StaticDecode, Type } from "@sinclair/typebox";
import { PluginChain } from "./plugin-configuration";
import { GitHubEventHandler } from "../github-event-handler";
import { CommandCall } from "../../types/command";
import { jsonType } from "../../types/util";

export const expressionRegex = /^\s*\${{\s*(\S+)\s*}}\s*$/;

export const pluginOutputSchema = Type.Object({
  state_id: Type.String(), // GitHub forces snake_case
  output: jsonType(Type.Record(Type.String(), Type.Unknown())),
});

export type PluginOutput = StaticDecode<typeof pluginOutputSchema>;

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

  public async getWorkflowInputs() {
    const inputs = {
      stateId: this.stateId,
      eventName: this.eventName,
      eventPayload: JSON.stringify(this.eventPayload),
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

  public async getWorkerInputs() {
    const inputs = {
      stateId: this.stateId,
      eventName: this.eventName,
      eventPayload: this.eventPayload,
      settings: this.settings,
      authToken: this.authToken,
      ref: this.ref,
      command: this.command,
    };
    const signature = await this.eventHandler.signPayload(JSON.stringify(inputs));
    return {
      ...inputs,
      signature,
    };
  }
}

export type PluginChainState<T extends EmitterWebhookEventName = EmitterWebhookEventName> = {
  eventId: string;
  eventName: T;
  eventPayload: EmitterWebhookEvent<T>["payload"];
  currentPlugin: number;
  pluginChain: PluginChain;
  inputs: PluginInput[];
  outputs: PluginOutput[];
  additionalProperties?: Record<string, unknown>;
};
