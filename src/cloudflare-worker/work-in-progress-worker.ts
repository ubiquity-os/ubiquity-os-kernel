import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";

const webhookSecret = process.env.WEBHOOK_SECRET || "default_secret";
if (typeof webhookSecret !== "string") {
  throw new Error("WEBHOOK_SECRET is not set");
}

const webhooks = new Webhooks({
  secret: webhookSecret,
});

addEventListener("fetch", (event: FetchEvent) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request: Request): Promise<Response> {
  const middleware = createNodeMiddleware(webhooks, { path: "/events" });
  const hasResponse: boolean = await middleware(request, null);
  return hasResponse ? new Response("OK", { status: 200 }) : new Response("Not found", { status: 404 });
}
