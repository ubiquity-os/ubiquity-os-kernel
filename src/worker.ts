import { EmitterWebhookEventName as WebhookEventName, emitterEventNames } from "@octokit/webhooks";
import { Value } from "@sinclair/typebox/value";
import { LogLevel } from "ubiquibot-logger/pretty-logs";
import { EventHandler } from "./event-handler";
import { bindHandlers } from "./handlers";
import { Env, envSchema } from "./types/env";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      validateEnv(env);
      const eventName = getEventName(request);
      const signatureSHA256 = getSignature(request);
      const id = getId(request);

      const eventHandler = new EventHandler({
        webhookSecret: env.WEBHOOK_SECRET,
        appId: env.APP_ID,
        privateKey: env.PRIVATE_KEY,
        supabaseUrl: env.SUPABASE_URL,
        supabaseKey: env.SUPABASE_KEY,
        logLevel: LogLevel[env.LOG_LEVEL as keyof typeof LogLevel],
        logRetryLimit: Number(env.LOG_RETRY_LIMIT),
      });
      bindHandlers(eventHandler);

      await eventHandler.webhooks.verifyAndReceive({
        id,
        name: eventName,
        payload: await request.text(),
        signature: signatureSHA256,
      });
      return new Response("ok\n", { status: 200, headers: { "content-type": "text/plain" } });
    } catch (error) {
      console.error(error);
      let status = 500;
      let errorMessage = "An Unspecified error occurred";
      if (error instanceof AggregateError) {
        const err = error.errors[0];
        errorMessage = err.message ? `${err.name}: ${err.message}` : "Error: An Unspecified error occurred";
        status = typeof err.status !== "undefined" ? err.status : 500;
      }
      return new Response(JSON.stringify({ error: errorMessage }), { status: status, headers: { "content-type": "application/json" } });
    }
  },
};

function validateEnv(env: Env): void {
  if (!Value.Check(envSchema, env)) {
    const errors = [...Value.Errors(envSchema, env)];
    console.error("Invalid environment variables", errors);
    throw new Error("Invalid environment variables");
  }
}

function getEventName(request: Request): WebhookEventName {
  const eventName = request.headers.get("x-github-event");
  if (!eventName || !emitterEventNames.includes(eventName as WebhookEventName)) {
    throw new Error(`Unsupported or missing "x-github-event" header value: ${eventName}`);
  }
  return eventName as WebhookEventName;
}

function getSignature(request: Request): string {
  const signatureSHA256 = request.headers.get("x-hub-signature-256");
  if (!signatureSHA256) {
    throw new Error(`Missing "x-hub-signature-256" header`);
  }
  return signatureSHA256;
}

function getId(request: Request): string {
  const id = request.headers.get("x-github-delivery");
  if (!id) {
    throw new Error(`Missing "x-github-delivery" header`);
  }
  return id;
}
