import { EmitterWebhookEvent, Webhooks } from "@octokit/webhooks";
import { createAppAuth } from "@octokit/auth-app";
import { signPayload } from "@ubiquity-os/plugin-sdk/signature";
import OpenAI from "openai";

import { customOctokit } from "./github-client";
import { GitHubContext, SimplifiedContext } from "./github-context";
import { KvStore } from "./utils/kv-store";
import { PluginChainState } from "./types/plugin";

export type Options = {
  environment: "production" | "development";
  webhookSecret: string;
  appId: string | number;
  privateKey: string;
  pluginChainState: KvStore<PluginChainState>;
  openAiClient: OpenAI;
};

export class GitHubEventHandler {
  public webhooks: Webhooks<SimplifiedContext>;
  public on: Webhooks<SimplifiedContext>["on"];
  public onAny: Webhooks<SimplifiedContext>["onAny"];
  public onError: Webhooks<SimplifiedContext>["onError"];
  public pluginChainState: KvStore<PluginChainState>;

  readonly environment: "production" | "development";
  private readonly _webhookSecret: string;
  private readonly _privateKey: string;
  private readonly _appId: number;
  private readonly _openAiClient: OpenAI;

  constructor(options: Options) {
    this.environment = options.environment;
    this._privateKey = options.privateKey;
    this._appId = Number(options.appId);
    this._webhookSecret = options.webhookSecret;
    this.pluginChainState = options.pluginChainState;
    this._openAiClient = options.openAiClient;

    this.webhooks = new Webhooks<SimplifiedContext>({
      secret: this._webhookSecret,
      transform: (event) => this.transformEvent(event), // it is important to use an arrow function here to keep the context of `this`
    });

    this.on = this.webhooks.on;
    this.onAny = this.webhooks.onAny;
    this.onError = this.webhooks.onError;

    this.onAny((event) => {
      console.log(`Event ${event.name} received (id: ${event.id})`);
    });
    this.onError((error) => {
      console.error(error);
    });
  }

  async signPayload(payload: string) {
    return signPayload(payload, this._privateKey);
  }

  transformEvent(event: EmitterWebhookEvent) {
    if ("installation" in event.payload && event.payload.installation?.id !== undefined) {
      const octokit = this.getAuthenticatedOctokit(event.payload.installation.id);
      return new GitHubContext(this, event, octokit, this._openAiClient);
    } else {
      const octokit = this.getUnauthenticatedOctokit();
      return new GitHubContext(this, event, octokit, this._openAiClient);
    }
  }

  getAuthenticatedOctokit(installationId: number) {
    return new customOctokit({
      auth: {
        appId: this._appId,
        privateKey: this._privateKey,
        installationId: installationId,
      },
    });
  }

  getUnauthenticatedOctokit() {
    return new customOctokit({
      auth: {
        appId: this._appId,
        privateKey: this._privateKey,
      },
    });
  }

  async getToken(installationId: number) {
    const auth = createAppAuth({
      appId: this._appId,
      privateKey: this._privateKey,
    });
    const token = await auth({ type: "installation", installationId });
    return token.token;
  }
}
