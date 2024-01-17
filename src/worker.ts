import { EmitterWebhookEventName, Webhooks, emitterEventNames } from "@octokit/webhooks";
import { Type as T, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { GitHubEvent } from "./types/github-events";
import { handleEvent } from "./webhooks";
const envSchema = T.Object({ WEBHOOK_SECRET: T.String() });
type Env = Static<typeof envSchema>;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!Value.Check(envSchema, env)) {
      const errors = [...Value.Errors(envSchema, env)];
      console.error("Invalid environment variables", errors);
      return new Response(JSON.stringify({ error: "Invalid environment variables" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    let pathname;
    try {
      pathname = new URL(request.url, "http://localhost").pathname;
    } catch (error) {
      return new Response(JSON.stringify({ error: `Request URL could not be parsed: ${request.url}` }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    }
    if (pathname !== "/events" || request.method !== "POST") {
      return new Response(JSON.stringify({ error: `Unknown route: ${request.method} ${request.url}` }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (!request.headers.get("content-type") || !request.headers.get("content-type")?.startsWith("application/json")) {
      return new Response(JSON.stringify({ error: `Unsupported "Content-Type" header value. Must be "application/json"` }), {
        status: 415,
        headers: { "content-type": "application/json" },
      });
    }
    const eventName = request.headers.get("x-github-event");
    if (!eventName) {
      return new Response(JSON.stringify({ error: `Missing "x-github-event" header` }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const signatureSHA256 = request.headers.get("x-hub-signature-256");
    if (!signatureSHA256) {
      return new Response(JSON.stringify({ error: `Missing "x-hub-signature-256" header` }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const id = request.headers.get("x-github-delivery");
    if (!id) {
      return new Response(JSON.stringify({ error: `Missing "x-github-delivery" header` }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (!emitterEventNames.includes(eventName as EmitterWebhookEventName)) {
      return new Response(JSON.stringify({ error: `Unsupported "x-github-event" header value: ${eventName}` }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const webhooks = new Webhooks({ secret: env.WEBHOOK_SECRET });
    webhooks.on(Object.values(GitHubEvent), handleEvent);
    // console.debug(`${eventName} event received (id: ${id})`);
    try {
      await webhooks.verifyAndReceive({
        id,
        name: eventName as EmitterWebhookEventName,
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
