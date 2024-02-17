import { EmitterWebhookEventName as WebhookEventName, emitterEventNames } from "@octokit/webhooks";
import { Value } from "@sinclair/typebox/value";
import { GitHubEventHandler } from "./github/github-event-handler";
import { bindHandlers } from "./github/handlers";
import { Env, envSchema } from "./github/types/env";
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    validateEnv(env);
    const eventName = getEventName(request);
    const signatureSHA256 = getSignature(request);
    const id = getId(request);
    const eventHandler = new GitHubEventHandler({ webhookSecret: env.WEBHOOK_SECRET, appId: env.APP_ID, privateKey: env.PRIVATE_KEY });
    bindHandlers(eventHandler);
    await eventHandler.webhooks.verifyAndReceive({ id, name: eventName, payload: await request.text(), signature: signatureSHA256 });
    return new Response("ok\n", { status: 200, headers: { "content-type": "text/plain" } });
  },
};
function validateEnv(env: Env): void {
  if (!Value.Check(envSchema, env)) {
    const errors = [...Value.Errors(envSchema, env)];
    // console.error("Invalid environment variables", errors);
    throw new Error(`Invalid environment variables: ${errors}`);
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
