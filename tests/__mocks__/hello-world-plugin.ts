import { createServer } from "@mswjs/http-middleware";
import { Octokit } from "@octokit/core";
import { http, HttpResponse } from "msw";
import { decompressString } from "@ubiquity-os/plugin-sdk/compression";
import { callLlm } from "@ubiquity-os/plugin-sdk";
import type { Context } from "@ubiquity-os/plugin-sdk";
import manifest from "./manifest.json";

type KernelInput = {
  authToken: string;
  eventPayload: string; // Compressed JSON string
  settings: string; // JSON string
  command: string; // JSON string of CommandCall (can be "null")
  ubiquityKernelToken?: string;
  stateId: string;
  eventName: string;
  ref: string;
};

const PORT = 9090;

type LlmCompletion = { choices?: Array<{ message?: { content?: unknown } }> };

async function callAi({
  authToken,
  ubiquityKernelToken,
  payload,
  prompt,
}: {
  authToken: string;
  ubiquityKernelToken?: string;
  payload: unknown;
  prompt: string;
}): Promise<string> {
  const llmContext = { authToken, ubiquityKernelToken, payload } satisfies Pick<Context, "authToken" | "ubiquityKernelToken" | "payload">;
  const completion = (await callLlm(
    {
      model: "gpt-5.2-chat-latest",
      messages: [{ role: "user", content: prompt }],
      stream: false,
    },
    llmContext as unknown as Context
  )) as unknown as LlmCompletion;

  return String(completion.choices?.[0]?.message?.content ?? "");
}

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
    const commandName = parsedCommand?.name;
    if (commandName !== "hello" && commandName !== "llm") {
      console.log(`[HELLO-WORLD-PLUGIN] Skipping command: ${commandName || "none"}`);
      return HttpResponse.json({
        state_id: body.stateId,
        output: `{ "result": "skipped", "message": "Command not handled by this plugin" }`,
      });
    }

    // Decompress and parse the event payload and settings
    const eventPayload = JSON.parse(decompressString(body.eventPayload));
    const settings = JSON.parse(body.settings);

    const octokit = new Octokit({ auth: body.authToken });

    let responseBody = settings.response || "Hello World!";
    if (commandName === "llm") {
      const prompt = String(parsedCommand?.parameters?.prompt ?? "").trim();
      if (!prompt) {
        responseBody = "Missing prompt. Usage: `/llm <prompt>`";
      } else if (!body.authToken || body.authToken === "mock-token") {
        responseBody = "Missing a real GitHub auth token for `/llm` (authToken).";
      } else {
        try {
          responseBody =
            (await callAi({
              authToken: body.authToken,
              ubiquityKernelToken: body.ubiquityKernelToken,
              payload: eventPayload,
              prompt,
            })) || "(empty response)";
        } catch (error) {
          console.error("[HELLO-WORLD-PLUGIN] LLM call failed", error);
          const message = error instanceof Error ? error.message : String(error);
          responseBody = `Failed to call the LLM service.\n\n${message}`;
        }
      }
    }

    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: eventPayload.repository.owner.login,
      repo: eventPayload.repository.name,
      issue_number: eventPayload.issue.number,
      body: responseBody,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    return HttpResponse.json({
      state_id: body.stateId,
      output: `{ "result": "success", "message": ${JSON.stringify(responseBody)} }`,
    });
  }),
  http.get("/manifest.json", () => {
    return HttpResponse.json(manifest);
  }),
];

const httpServer = createServer(...handlers);

httpServer.listen(PORT);
console.log(`hello-world-plugin is listening on http://127.0.0.1:${PORT}`);
