import { EmitterWebhookEvent, EmitterWebhookEventName } from "@octokit/webhooks";
import { StaticDecode, Type } from "@sinclair/typebox";
import { PluginChain } from "./plugin-configuration";
import { GitHubEventHandler } from "../github-event-handler";

export const expressionRegex = /^\s*\${{\s*(\S+)\s*}}\s*$/;

function jsonString() {
  return Type.Transform(Type.String())
    .Decode((value) => JSON.parse(value) as Record<string, unknown>)
    .Encode((value) => JSON.stringify(value));
}

export const pluginOutputSchema = Type.Object({
  state_id: Type.String(), // GitHub forces snake_case
  output: jsonString(),
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

  constructor(
    eventHandler: GitHubEventHandler,
    stateId: string,
    eventName: T,
    eventPayload: EmitterWebhookEvent<T>["payload"],
    settings: unknown,
    authToken: string,
    ref: string
  ) {
    this.eventHandler = eventHandler;
    this.stateId = stateId;
    this.eventName = eventName;
    this.eventPayload = eventPayload;
    this.settings = settings;
    this.authToken = authToken;
    this.ref = ref;
  }

  public async getWorkflowInputs() {
    const inputs = {
      stateId: this.stateId,
      eventName: this.eventName,
      eventPayload: JSON.stringify(this.eventPayload),
      settings: JSON.stringify(this.settings),
      authToken: this.authToken,
      ref: this.ref,
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
