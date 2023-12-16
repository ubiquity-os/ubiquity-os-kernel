import { Webhooks } from "@octokit/webhooks";
import dotenv from "dotenv";
import { GitHubEvent } from "./github-events"; // Import the enum

dotenv.config();

const clientSecret = process.env.GITHUB_CLIENT_SECRET;
if (!clientSecret) {
  throw new Error("GITHUB_CLIENT_SECRET environment variable is not set");
}

const webhooks = new Webhooks({ secret: clientSecret });

// Loop through all GitHubEvent enum values and set up listeners
for (const eventName of Object.values(GitHubEvent)) {
  webhooks.on(eventName, async ({ id, name, payload }) => {
    id;
    console.log(`Event received: ${name}`);
    console.trace(payload);
    // Handle each event type accordingly
  });
}
