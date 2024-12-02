import { Hono, HonoRequest } from "hono";
import { Env, envSchema } from "./github/types/env";
import { Value } from "@sinclair/typebox/value";
import { WebhookEventName } from "@octokit/webhooks-types";
import { emitterEventNames } from "@octokit/webhooks";
import OpenAI from "openai";
import { GitHubEventHandler } from "./github/github-event-handler";
import { EmptyStore } from "./github/utils/kv-store";
import { bindHandlers } from "./github/handlers";
const app = new Hono();

function validateEnv(env: Env): void {
  if (!Value.Check(envSchema, env)) {
    const errors = [...Value.Errors(envSchema, env)];
    console.error("Invalid environment variables", errors);
    throw new Error("Invalid environment variables");
  }
}

export function getEventName(request: HonoRequest): WebhookEventName {
  const eventName = request.header("x-github-event");
  if (!eventName || !emitterEventNames.includes(eventName as WebhookEventName)) {
    throw new Error(`Unsupported or missing "x-github-event" header value: ${eventName}`);
  }
  return eventName as WebhookEventName;
}

export function getSignature(request: HonoRequest): string {
  const signatureSha256 = request.header("x-hub-signature-256");
  if (!signatureSha256) {
    throw new Error(`Missing "x-hub-signature-256" header`);
  }
  return signatureSha256;
}

export function getId(request: HonoRequest): string {
  const id = request.header("x-github-delivery");
  if (!id) {
    throw new Error(`Missing "x-github-delivery" header`);
  }
  return id;
}

function handleUncaughtError(error: unknown) {
  console.error(error);
  let status = 500;
  let errorMessage = "An uncaught error occurred";
  if (error instanceof AggregateError) {
    const err = error.errors[0];
    errorMessage = err.message ? `${err.name}: ${err.message}` : `Error: ${errorMessage}`;
    status = typeof err.status !== "undefined" ? err.status : 500;
  } else {
    errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : `Error: ${error}`;
  }
  return new Response(JSON.stringify({ error: errorMessage }), { status: status, headers: { "content-type": "application/json" } });
}

app.get("/", async (c) => {
  try {
    const env = c.env as Env;
    const request = c.req;
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
    await eventHandler.webhooks.verifyAndReceive({
      id,
      name: eventName,
      payload: await request.text(),
      signature: signatureSha256,
    });
  } catch (error) {
    return handleUncaughtError(error);
  }

  return c.text("OK");
});

export default app;
