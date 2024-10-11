import { EmitterWebhookEvent, Webhooks } from "@octokit/webhooks";
import { customOctokit } from "./github-client";
import { GitHubContext, SimplifiedContext } from "./github-context";
import { createAppAuth } from "@octokit/auth-app";
import { CloudflareKv } from "./utils/cloudflare-kv";
import { PluginChainState } from "./types/plugin";

export type Options = {
  environment: "production" | "development";
  webhookSecret: string;
  appId: string | number;
  privateKey: string;
  pluginChainState: CloudflareKv<PluginChainState>;
};

export class GitHubEventHandler {
  public webhooks: Webhooks<SimplifiedContext>;
  public on: Webhooks<SimplifiedContext>["on"];
  public onAny: Webhooks<SimplifiedContext>["onAny"];
  public onError: Webhooks<SimplifiedContext>["onError"];
  public pluginChainState: CloudflareKv<PluginChainState>;

  readonly environment: "production" | "development";
  private readonly _webhookSecret: string;
  private readonly _privateKey: string;
  private readonly _appId: number;

  constructor(options: Options) {
    this.environment = options.environment;
    this._privateKey = options.privateKey;
    this._appId = Number(options.appId);
    this._webhookSecret = options.webhookSecret;
    this.pluginChainState = options.pluginChainState;

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

  async importRsaPrivateKey(pem: string) {
    const pemContents = pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").trim();
    const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

    return await crypto.subtle.importKey(
      "pkcs8",
      binaryDer.buffer as ArrayBuffer,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      true,
      ["sign"]
    );
  }

  async signPayload(payload: string) {
    const data = new TextEncoder().encode(payload);
    const privateKey = await this.importRsaPrivateKey(this._privateKey);
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data);
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  transformEvent(event: EmitterWebhookEvent) {
    if ("installation" in event.payload && event.payload.installation?.id !== undefined) {
      const octokit = this.getAuthenticatedOctokit(event.payload.installation.id);
      return new GitHubContext(this, event, octokit);
    } else {
      const octokit = this.getUnauthenticatedOctokit();
      return new GitHubContext(this, event, octokit);
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
