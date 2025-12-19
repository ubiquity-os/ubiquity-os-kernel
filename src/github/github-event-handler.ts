import { createAppAuth } from "@octokit/auth-app";
import { EmitterWebhookEvent, Webhooks } from "@octokit/webhooks";
import { signPayload } from "@ubiquity-os/plugin-sdk/signature";
import OpenAI from "openai";
import { logger } from "../logger/logger";

import { customOctokit } from "./github-client";
import { GitHubContext, SimplifiedContext } from "./github-context";
export type Options = {
  environment: string;
  webhookSecret: string;
  appId: string | number;
  privateKey: string;
  llmClient: OpenAI;
  llm: string;
  aiBaseUrl?: string;
  aiFallbackBaseUrl?: string;
  agent?: {
    owner: string;
    repo: string;
    workflowId: string;
    ref?: string;
  };
  logger?: typeof logger;
};

export class GitHubEventHandler {
  public webhooks: Webhooks<SimplifiedContext>;
  public on: Webhooks<SimplifiedContext>["on"];
  public onAny: Webhooks<SimplifiedContext>["onAny"];
  public onError: Webhooks<SimplifiedContext>["onError"];

  readonly environment: string;
  private readonly _webhookSecret: string;
  private readonly _privateKey: string;
  private _cachedKernelPublicKeyPem?: string;
  private readonly _appId: number;
  private readonly _llmClient: OpenAI;
  public readonly llm: string;
  public readonly aiBaseUrl: string;
  public readonly aiFallbackBaseUrl: string;
  public readonly agent: {
    owner: string;
    repo: string;
    workflowId: string;
    ref?: string;
  };
  public readonly logger = logger;

  constructor(options: Options) {
    this.environment = options.environment;
    this._privateKey = normalizeMultilineSecret(options.privateKey);
    this._appId = Number(options.appId);
    this._webhookSecret = options.webhookSecret;
    this._llmClient = options.llmClient;
    this.llm = options.llm;
    this.aiBaseUrl = options.aiBaseUrl ?? "https://ai.ubq.fi";
    this.aiFallbackBaseUrl = options.aiFallbackBaseUrl ?? "https://ai-ubq-fi.deno.dev";
    this.agent = {
      owner: options.agent?.owner ?? "ubiquity-os",
      repo: options.agent?.repo ?? "ubiquity-os-kernel",
      workflowId: options.agent?.workflowId ?? "agent.yml",
      ref: options.agent?.ref,
    };

    if (options.logger) {
      this.logger = options.logger;
    }

    this.webhooks = new Webhooks<SimplifiedContext>({
      secret: this._webhookSecret,
      transform: (event) => this.transformEvent(event), // it is important to use an arrow function here to keep the context of `this`
    });

    this.on = this.webhooks.on;
    this.onAny = this.webhooks.onAny;
    this.onError = this.webhooks.onError;

    this.onAny((event) => {
      this.logger.github({ event: event.name, id: event.id }, "Event received");
    });
    this.onError((error) => {
      this.logger.github({ err: error, secret: this._webhookSecret.substring(0, 10) + "..." }, "Webhook error - check secret match");
    });
  }

  async signPayload(payload: string) {
    return signPayload(payload, this._privateKey);
  }

  async getKernelPublicKeyPem(): Promise<string> {
    if (this._cachedKernelPublicKeyPem) return this._cachedKernelPublicKeyPem;
    this._cachedKernelPublicKeyPem = await deriveRsaPublicKeyPemFromPrivateKey(this._privateKey);
    return this._cachedKernelPublicKeyPem;
  }

  transformEvent(event: EmitterWebhookEvent) {
    if ("installation" in event.payload && event.payload.installation?.id !== undefined) {
      const octokit = this.getAuthenticatedOctokit(event.payload.installation.id);
      return new GitHubContext(this, event, octokit, this._llmClient, this.logger);
    } else {
      const octokit = this.getUnauthenticatedOctokit();
      return new GitHubContext(this, event, octokit, this._llmClient, this.logger);
    }
  }

  getAuthenticatedOctokit(installationId: number) {
    return new customOctokit({
      request: {
        fetch: fetch.bind(globalThis),
      },
      log: {
        debug: (msg: string, info?: unknown) => this.logger.github({ info }, msg),
        info: (msg: string, info?: unknown) => this.logger.github({ info }, msg),
        warn: (msg: string, info?: unknown) => this.logger.github({ info }, msg),
        error: (msg: string, info?: unknown) => this.logger.github({ info }, msg),
      },
      auth: {
        appId: this._appId,
        privateKey: this._privateKey,
        installationId: installationId,
      },
    });
  }

  getUnauthenticatedOctokit() {
    return new customOctokit({
      request: {
        fetch: fetch.bind(globalThis),
      },
      log: {
        debug: (msg: string, info?: unknown) => this.logger.github({ info }, msg),
        info: (msg: string, info?: unknown) => this.logger.github({ info }, msg),
        warn: (msg: string, info?: unknown) => this.logger.github({ info }, msg),
        error: (msg: string, info?: unknown) => this.logger.github({ info }, msg),
      },
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

function normalizeMultilineSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.includes("\n") && trimmed.includes("\\n")) {
    return trimmed.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
  }
  return trimmed.replace(/\r\n/g, "\n");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function wrapPem(type: string, base64: string): string {
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----\n`;
}

async function deriveRsaPublicKeyPemFromPrivateKey(privateKeyPem: string): Promise<string> {
  const pemContents = privateKeyPem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").trim();
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const privateKey = await crypto.subtle.importKey("pkcs8", binaryDer.buffer as ArrayBuffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]);

  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  if (!jwk.n || !jwk.e) {
    throw new Error("Unable to derive kernel public key: missing RSA modulus/exponent");
  }

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"]
  );

  const spkiDer = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  return wrapPem("PUBLIC KEY", bytesToBase64(spkiDer));
}
