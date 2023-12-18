import SmeeClient from "smee-client";

import dotenv from "dotenv";
dotenv.config();

export function webhookForwarder() {
  const webhookProxyUrl = process.env.WEBHOOK_PROXY_URL;
  if (!webhookProxyUrl) {
    throw new Error("WEBHOOK_PROXY_URL environment variable is not set");
  }
  const smee = new SmeeClient({
    source: webhookProxyUrl,
    target: "http://localhost:3000/events",
    logger: console,
  });

  const events = smee.start();

  return events;
  // const events = smee.start();

  // Stop forwarding events
  // events.close();
}
