import { EmitterWebhookEvent, EmitterWebhookEventName } from "@octokit/webhooks";
import { compressString } from "@ubiquity-os/plugin-sdk/compression";
import { GitHubEventHandler } from "../github-event-handler.ts";
import { createKernelAttestationToken } from "../utils/kernel-attestation.ts";

type RepositoryPayload = {
  repository?: {
    owner?: {
      login?: unknown;
    };
    name?: unknown;
  };
  installation?: {
    id?: unknown;
  };
};

type CommandCall = { name: string; parameters: unknown } | null;

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractRepoContext(payload: unknown): { owner: string; repo: string; installationId: number | null } {
  const maybePayload = payload as RepositoryPayload;
  return {
    owner: readString(maybePayload.repository?.owner?.login),
    repo: readString(maybePayload.repository?.name),
    installationId: readFiniteNumber(maybePayload.installation?.id),
  };
}

export class PluginInput<T extends EmitterWebhookEventName = EmitterWebhookEventName> {
  public eventHandler: GitHubEventHandler;
  public stateId: string;
  public eventName: T;
  public eventPayload: EmitterWebhookEvent<T>["payload"];
  public settings: unknown;
  public authToken: string;
  public ubiquityKernelToken?: string;
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
    const { owner, repo, installationId } = extractRepoContext(this.eventPayload);

    const ubiquityKernelToken = await createKernelAttestationToken({
      sign: (payload) => this.eventHandler.signPayload(payload),
      owner,
      repo,
      installationId,
      authToken: this.authToken,
      stateId: this.stateId,
      ttlSeconds: 60 * 60,
    });

    const signableInputs = {
      stateId: this.stateId,
      eventName: this.eventName,
      eventPayload: compressString(JSON.stringify(this.eventPayload)),
      settings: JSON.stringify(this.settings),
      authToken: this.authToken,
      ubiquityKernelToken,
      ref: this.ref,
      command: JSON.stringify(this.command),
    };
    const signature = await this.eventHandler.signPayload(JSON.stringify(signableInputs));
    return {
      ...signableInputs,
      ubiquityKernelToken,
      signature,
    };
  }
}
