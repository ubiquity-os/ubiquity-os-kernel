import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";
import dotenv from "dotenv";
import http from "http";
import { GitHubEvent } from "./github-events";
import { webhookForwarder } from "./smee-client";
dotenv.config();
const webhookSecret = process.env.WEBHOOK_SECRET;
if (!webhookSecret) {
  throw new Error("WEBHOOK_SECRET environment variable is not set");
}

webhookForwarder();

// Create a new instance of the `Webhooks` class, passing in the secret
const webhooks = new Webhooks({
  secret: webhookSecret,
});

// Add event listeners to the `webhooks` instance
for (const eventName of Object.values(GitHubEvent)) {
  webhooks.on(eventName, (baseWebhookEvent) => {
    // { id, name, payload }
    console.trace(baseWebhookEvent);
  });
}
// Create an HTTP server and pass the `webhooks.middleware` to it
const server = http.createServer(createNodeMiddleware(webhooks, { path: "/events" }));

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Server listening on port ${port}`));
