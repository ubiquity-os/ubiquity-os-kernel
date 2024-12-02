import { app } from "@azure/functions";
import { azureHonoHandler } from "@marplex/hono-azurefunc-adapter";
import honoApp from "../app";

app.http("http-trigger", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "{*proxy}",
  handler: azureHonoHandler(honoApp.fetch),
});
