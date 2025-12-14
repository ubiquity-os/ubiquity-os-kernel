import { createServer } from "@mswjs/http-middleware";
import { Octokit } from "@octokit/core";
import { http, HttpResponse } from "msw";
import { decompressString } from "@ubiquity-os/plugin-sdk/compression";
import manifest from "./manifest.json";

type KernelInput = {
  authToken: string;
  eventPayload: string; // Compressed JSON string
  settings: string; // JSON string
  command: string; // JSON string of CommandCall (can be "null")
  stateId: string;
  eventName: string;
  ref: string;
};

const PORT = 9090;

const handlers = [
  http.post("/", async (data) => {
    const body: KernelInput = (await data.request.json()) as KernelInput;

    console.log(`[HELLO-WORLD-PLUGIN] Received request:`, {
      command: body.command,
      eventName: body.eventName,
      stateId: body.stateId,
    });

    // Parse the command
    const parsedCommand = JSON.parse(body.command);
    console.log(`[HELLO-WORLD-PLUGIN] Parsed command:`, parsedCommand);

    // Check if this plugin should handle the command
    if (!parsedCommand || parsedCommand.name !== "hello") {
      console.log(`[HELLO-WORLD-PLUGIN] Skipping command: ${parsedCommand?.name || "none"}`);
      return HttpResponse.json({
        state_id: body.stateId,
        output: `{ "result": "skipped", "message": "Command not handled by this plugin" }`,
      });
    }

    // Decompress and parse the event payload and settings
    const eventPayload = JSON.parse(decompressString(body.eventPayload));
    const settings = JSON.parse(body.settings);

    const octokit = new Octokit({ auth: body.authToken });

    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: eventPayload.repository.owner.login,
      repo: eventPayload.repository.name,
      issue_number: eventPayload.issue.number,
      body: settings.response || "Hello World!",
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    return HttpResponse.json({
      state_id: body.stateId,
      output: `{ "result": "success", "message": "${settings.response || "Hello World!"}" }`,
    });
  }),
  http.get("/manifest.json", () => {
    return HttpResponse.json(manifest);
  }),
];

const httpServer = createServer(...handlers);

httpServer.listen(PORT);
console.log(`hello-world-plugin is listening on http://127.0.0.1:${PORT}`);
