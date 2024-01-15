import dotenv from "dotenv";
import SmeeClient from "smee-client";
dotenv.config({ path: ".dev.vars" });

const smee = new SmeeClient({
  source: process.env.WEBHOOK_PROXY_URL || "https://smee.io/new",
  target: "http://localhost:8787/events",
  logger: console,
});

smee.start();
