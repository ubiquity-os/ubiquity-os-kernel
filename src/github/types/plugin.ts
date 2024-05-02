import { EmitterWebhookEvent, EmitterWebhookEventName } from "@octokit/webhooks";
import { StaticDecode, Type } from "@sinclair/typebox";
import { PluginChain } from "./plugin-configuration";

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

export class DelegatedComputeInputs<T extends EmitterWebhookEventName = EmitterWebhookEventName> {
  public stateId: string;
  public eventName: T;
  public eventPayload: EmitterWebhookEvent<T>["payload"];
  public settings: unknown;
  public authToken: string;
  public ref: string;

  constructor(stateId: string, eventName: T, eventPayload: EmitterWebhookEvent<T>["payload"], settings: unknown, authToken: string, ref: string) {
    this.stateId = stateId;
    this.eventName = eventName;
    this.eventPayload = eventPayload;
    this.settings = settings;
    this.authToken = authToken;
    this.ref = ref;
  }

  public getInputs() {
    return {
      stateId: this.stateId,
      eventName: this.eventName,
      eventPayload: JSON.stringify(this.eventPayload),
      settings: JSON.stringify(this.settings),
      authToken: this.authToken,
      ref: this.ref,
    };
  }
}

export type PluginChainState<T extends EmitterWebhookEventName = EmitterWebhookEventName> = {
  eventId: string;
  eventName: T;
  eventPayload: EmitterWebhookEvent<T>["payload"];
  currentPlugin: number;
  pluginChain: PluginChain;
  inputs: DelegatedComputeInputs[];
  outputs: PluginOutput[];
};
