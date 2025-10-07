// src/mcp/mcp-server.ts

import { Context } from "hono";
import { AgentRegistry } from "../agent/agent-registry";
import { GitHubContext } from "../github/github-context";
import { GitHubEventHandler } from "../github/github-event-handler";
import { EmitterWebhookEvent } from "@octokit/webhooks";
import { WebhookEventName } from "@octokit/webhooks-types";
import { Env, envSchema } from "../github/types/env";
import { Value } from "@sinclair/typebox/value";
import { env as honoEnv } from "hono/adapter";
import OpenAI from "openai";
import { EmptyStore } from "../github/utils/kv-store";
import { getManifest } from "../github/utils/plugins";
import { GithubPlugin } from "../github/types/plugin-configuration";

// Helper to manually format Server-Sent Events
function generateSseMessage(event: string, data: unknown): string {
  const jsonData = JSON.stringify(data);
  return `event: ${event}\ndata: ${jsonData}\n\n`;
}

// Interfaces remain the same
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: unknown;
  method: string;
  params?: Record<string, unknown>;
}

interface McpTool {
  name: string;
  description?: string;
  server: string;
  inputSchema: unknown;
}

export class McpServer {
  private _agentRegistry: AgentRegistry;
  private _context: Context;
  private _githubContext: GitHubContext | null = null;
  private _encoder = new TextEncoder();

  constructor(context: Context, agentRegistry: AgentRegistry) {
    this._context = context;
    this._agentRegistry = agentRegistry;
  }

  public async handleRequest(request: JsonRpcRequest, owner?: string, installationId?: number): Promise<object | Response> {
    console.log("MCP Request Method:", request.method, "ID:", request.id);
    switch (request.method) {
      case "initialize":
        return this._initialize(request);

      case "tools/list":
      case "tools/call":
        if (!owner || !installationId) {
          return this._error(request, -32602, `Invalid params: 'x-owner' and 'x-installation-id' headers are required for ${request.method}`);
        }

        if (request.method === "tools/list") {
          this._githubContext = await this._createGitHubContext(installationId);
          await this._agentRegistry.loadAgents(this._githubContext, owner);
          console.log(`Loaded agents for owner: ${owner} and agents ${JSON.stringify(Array.from(this._agentRegistry.getAgents()), null, 2)}`);
          return this._listTools(request, owner, installationId);
        } else {
          this._githubContext = await this._createGitHubContext(installationId);
          await this._agentRegistry.loadAgents(this._githubContext, owner);
          console.log(`Loaded agents for owner: ${owner} and agents ${JSON.stringify(Array.from(this._agentRegistry.getAgents()), null, 2)}`);
          // This will now return a `Response` object if streaming, or a JSON object on error.
          return this._runTool(request, owner, installationId);
        }
      case "notifications/progress":
        console.log("Received notifications/progress:", request.params);
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: { received: true },
        };

      default:
        return this._error(request, -32601, "Method not found");
    }
  }

  private async _createGitHubContext(installationId: number): Promise<GitHubContext> {
    const env = Value.Decode(envSchema, Value.Default(envSchema, honoEnv(this._context))) as Env;

    const llmClient = new OpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: env.OPENROUTER_BASE_URL,
    });

    const eventHandler = new GitHubEventHandler({
      environment: env.ENVIRONMENT,
      webhookSecret: env.APP_WEBHOOK_SECRET,
      appId: env.APP_ID,
      privateKey: env.APP_PRIVATE_KEY,
      pluginChainState: new EmptyStore(this._context.var.logger),
      llmClient,
      llm: env.OPENROUTER_MODEL,
      logger: this._context.var.logger,
    });

    const octokit = eventHandler.getAuthenticatedOctokit(installationId);

    return new GitHubContext(
      eventHandler,
      { name: "repository_dispatch" as WebhookEventName, id: this._context.var.requestId, payload: {} } as EmitterWebhookEvent<"repository_dispatch">,
      octokit,
      llmClient,
      this._context.var.logger
    );
  }

  // --- Tool Execution Logic (Refactored for Streaming) ---
  private async _runTool(request: JsonRpcRequest, owner: string, installationId: number): Promise<object | Response> {
    const { name, arguments: inputs } = request.params as { name: string; arguments: Record<string, unknown> };
    const [agentId, capability] = name.split("_");

    if (!agentId || !capability) {
      return this._error(request, -32602, "Invalid params: 'name' must be in the format 'agentId_capability'");
    }

    console.log(`✅ [POST] Handling "tools/call" for [${name}]...`);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Launch the background task to create the job and stream its progress.
    void this._createAndStreamJob(writer, request.id, { agentId, capability, inputs, owner, installationId });

    // Return the readable stream immediately to prevent the timeout.
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private async _createAndStreamJob(
    writer: WritableStreamDefaultWriter,
    originalId: unknown,
    jobDetails: { agentId: string; capability: string; inputs: Record<string, unknown>; owner: string; installationId: number }
  ) {
    try {
      this._githubContext = await this._createGitHubContext(jobDetails.installationId);
      await this._agentRegistry.loadAgents(this._githubContext, jobDetails.owner);
      const jobId = await this._createAgentJob(jobDetails.agentId, jobDetails.capability, jobDetails.inputs, jobDetails.owner, jobDetails.installationId);
      await this._writeJobStream(writer, originalId, jobId);
    } catch (err: unknown) {
      console.error("Failed to create or stream agent job:", err);
      const errorResponse = this._error(
        { id: originalId, jsonrpc: "2.0", method: "tools/call" },
        -32000,
        `Job creation failed: ${err instanceof Error ? err.message : String(err)}`
      );
      await writer.write(this._encoder.encode(generateSseMessage("message", errorResponse)));
      void writer.close();
    }
  }

  private async _writeJobStream(writer: WritableStreamDefaultWriter, originalId: unknown, jobId: string) {
    console.log(`   -> Stream task started for Job ID: [${jobId}]`);
    const write = (data: unknown) => writer.write(this._encoder.encode(generateSseMessage("message", data)));

    const sendProgressNotification = (message: string) => {
      writer
        .write(
          this._encoder.encode(
            generateSseMessage("message", {
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: {
                progressToken: originalId,
                progress: 0.5,
                total: 1,
                message,
              },
            })
          )
        )
        .catch((err) => {
          console.debug("Progress notification write failed, client might be disconnected:", err.message);
        });
    };

    let progressInterval: number | undefined;

    try {
      await write({
        jsonrpc: "2.0",
        method: "patch",
        params: { context: ["-"], patch: [{ op: "add", path: "/-/", value: { jobId, status: "pending", outputs: null, error: null } }] },
      });

      progressInterval = setInterval(() => {
        sendProgressNotification("Ongoing analysis...");
      }, 5000) as unknown as number;

      for await (const jobState of this._agentRegistry.watchJob(jobId)) {
        if (jobState) {
          console.log(`   -> Job [${jobId}] state changed: ${jobState.status}`);
          await write({
            jsonrpc: "2.0",
            method: "patch",
            params: {
              context: ["0"],
              patch: [
                { op: "replace", path: "/status", value: jobState.status },
                { op: "replace", path: "/outputs", value: jobState.outputs },
                { op: "replace", path: "/error", value: jobState.error },
              ],
            },
          });

          if (jobState.status === "completed" || jobState.status === "failed") {
            await write({ jsonrpc: "2.0", method: "done", params: { context: ["0"] } });
            break;
          }
        }
      }

      const finalState = await this._agentRegistry.getJobState(jobId);

      const formattedOutputs = finalState?.outputs ? [this._formatToolOutput(finalState.outputs)] : [];

      await write({
        jsonrpc: "2.0",
        id: originalId,
        result: {
          status: finalState?.status || "unknown",
          content: formattedOutputs,
        },
      });
    } catch (error) {
      console.error("Stream write error (client likely disconnected):", error);
    } finally {
      if (progressInterval !== undefined) {
        clearInterval(progressInterval);
      }
      console.log(`   -> Stream task finished for Job ID: [${jobId}]. Closing stream.`);
      void writer.close();
    }
  }

  private async _createAgentJob(agentId: string, capability: string, inputs: Record<string, unknown>, owner: string, installationId: number): Promise<string> {
    this._githubContext = await this._createGitHubContext(installationId);

    const url = this._context.req.url;
    const baseUrl = new URL(url).origin;
    const callbackUrl = `${baseUrl}/agent/response`;

    const signature = await this._githubContext.eventHandler.signPayload(JSON.stringify(this._githubContext.payload));
    const token = await this._githubContext.eventHandler.getToken(Number(installationId));

    return this._agentRegistry.createJob(this._githubContext, agentId, capability, inputs, callbackUrl, signature, token, owner);
  }

  private async _initialize(request: JsonRpcRequest) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {
            list: true,
            call: true,
          },
          sampling: {},
          elicitation: {},
          roots: {
            listChanged: true,
          },
        },
        serverInfo: {
          name: "ubiquity-os-kernel",
          version: "1.0.0",
        },
      },
    };
  }

  private async _listTools(request: JsonRpcRequest, owner: string, installationId: number) {
    const githubContext = await this._createGitHubContext(installationId);

    await this._agentRegistry.loadAgents(githubContext, owner);
    const agents = this._agentRegistry.getAgents();
    const tools: McpTool[] = [];

    for (const agent of Array.from(agents.values())) {
      const manifest = await getManifest(githubContext, agent.agent as string | GithubPlugin);
      if (!manifest?.commands) continue;

      for (const [commandName, command] of Object.entries(manifest.commands)) {
        if (command.parameters) {
          delete (command.parameters as Record<string, unknown>)["callbackUrl"];
          delete (command.parameters as Record<string, unknown>)["jobId"];
        }
        tools.push({
          name: `${agent.id}_${commandName}`,
          description: command.description || `Command ${commandName} for agent ${agent.id}`,
          server: agent.id,
          inputSchema: {
            type: "object",
            properties: {
              ...(command.parameters || {}),
            },
          },
        });
      }
    }
    console.log("Tools:", tools);
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools,
      },
    };
  }

  private _formatToolOutput(output: unknown): object {
    if (
      typeof output === "object" &&
      output !== null &&
      "type" in output &&
      typeof (output as { type: unknown }).type === "string" &&
      ["text", "image", "audio", "resource_link", "resource"].includes((output as { type: string }).type)
    ) {
      return output;
    }

    const serializedText = typeof output === "string" ? output : JSON.stringify(output, null, 2);

    return {
      type: "text",
      text: serializedText,
    };
  }

  private _error(request: JsonRpcRequest, code: number, message: string) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code,
        message,
      },
    };
  }
}
