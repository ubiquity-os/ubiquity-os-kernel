import dotenv from "dotenv";
import SmeeClient from "smee-client";
import { createHmac } from "node:crypto";
dotenv.config({ path: ".dev.vars" });

const webhookSecret = String(process.env.APP_WEBHOOK_SECRET ?? "").trim();
const baseFetch: typeof fetch = global.fetch;

async function resigningFetch(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): Promise<Response> {
  if (!webhookSecret) return baseFetch(input, init);
  const body = init?.body;
  if (typeof body !== "string") return baseFetch(input, init);

  const headers = new Headers(init?.headers ?? {});
  const signature = createHmac("sha256", webhookSecret).update(body).digest("hex");
  headers.set("x-hub-signature-256", `sha256=${signature}`);

  return baseFetch(input, { ...init, headers });
}

const smee = new SmeeClient({
  source: process.env.WEBHOOK_PROXY_URL || "https://smee.io/new",
  target: "http://localhost:8787",
  logger: console,
  fetch: resigningFetch,
});

smee.start();
