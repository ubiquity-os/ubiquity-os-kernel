import { emitterEventNames } from "@octokit/webhooks";
import { Value } from "@sinclair/typebox/value";
import { GitHubEventHandler } from "./github/github-event-handler";
import { bindHandlers } from "./github/handlers";
import { Env, envSchema } from "./github/types/env";
import { EmptyStore } from "./github/utils/kv-store";
import { WebhookEventName } from "@octokit/webhooks-types";
import OpenAI from "openai";
import { Context, Hono, HonoRequest } from "hono";
import { env as honoEnv, getRuntimeKey } from "hono/adapter";
import { StatusCode } from "hono/utils/http-status";
import packageJson from "../package.json";

export const app = new Hono();

app.get("/", (c) => {
  return c.text(`Welcome to UbiquityOS kernel version ${packageJson.version}`);
});

app.post("/", async (ctx: Context) => {
  try {
    const env = honoEnv(ctx);
    const request = ctx.req;

    validateEnv(env);
    const eventName = getEventName(request);
    const signatureSha256 = getSignature(request);
    const id = getId(request);
    const openAiClient = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
    });
    const eventHandler = new GitHubEventHandler({
      environment: env.ENVIRONMENT,
      webhookSecret: env.APP_WEBHOOK_SECRET,
      appId: env.APP_ID,
      privateKey: env.APP_PRIVATE_KEY,
      pluginChainState: new EmptyStore(),
      openAiClient,
    });
    bindHandlers(eventHandler);

    // if running in Cloudflare Worker, handle the webhook in the background and return a response immediately
    if (getRuntimeKey() === "workerd") {
      ctx.executionCtx.waitUntil(eventHandler.webhooks.verifyAndReceive({ id, name: eventName, payload: await request.text(), signature: signatureSha256 }));
    } else {
      await eventHandler.webhooks.verifyAndReceive({ id, name: eventName, payload: await request.text(), signature: signatureSha256 });
    }
    return ctx.text("ok\n", 200);
  } catch (error) {
    return handleUncaughtError(ctx, error);
  }
});

function handleUncaughtError(ctx: Context, error: unknown) {
  console.error(error);
  let status = 500;
  let errorMessage = "An uncaught error occurred";
  if (error instanceof AggregateError) {
    const err = error.errors[0];
    errorMessage = err.message ? `${err.name}: ${err.message}` : `Error: ${errorMessage}`;
    status = typeof err.status !== "undefined" && typeof err.status === "number" ? err.status : 500;
  } else {
    errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : `Error: ${error}`;
  }
  return ctx.json({ error: errorMessage }, status as StatusCode);
}

function validateEnv(env: Env): void {
  if (!Value.Check(envSchema, env)) {
    const errors = [...Value.Errors(envSchema, env)];
    console.error("Invalid environment variables", errors);
    throw new Error("Invalid environment variables");
  }
}

function getEventName(request: HonoRequest): WebhookEventName {
  const eventName = request.header("x-github-event");
  if (!eventName || !emitterEventNames.includes(eventName as WebhookEventName)) {
    throw new Error(`Unsupported or missing "x-github-event" header value: ${eventName}`);
  }
  return eventName as WebhookEventName;
}

function getSignature(request: HonoRequest): string {
  const signatureSha256 = request.header("x-hub-signature-256");
  if (!signatureSha256) {
    throw new Error(`Missing "x-hub-signature-256" header`);
  }
  return signatureSha256;
}

function getId(request: HonoRequest): string {
  const id = request.header("x-github-delivery");
  if (!id) {
    throw new Error(`Missing "x-github-delivery" header`);
  }
  return id;
}
