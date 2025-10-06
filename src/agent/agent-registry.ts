import { logger } from "../logger/logger";
import yaml from "js-yaml";
import { Value } from "@sinclair/typebox/value";
import { AgentStateStore, EmptyStore, KvStore } from "../github/utils/kv-store";
import { GitHubContext } from "../github/github-context";
import { dispatchWorkflow, dispatchWorker } from "../github/utils/workflow-dispatch";
import { Agent, agentConfigSchema, AgentConfiguration, AgentJobState, isGithubAgent } from "./types/agent-configuration";
import { Context } from "hono";
import { env as honoEnv } from "hono/adapter";
import { Env, envSchema } from "../github/types/env";
import OpenAI from "openai";
import { GitHubEventHandler } from "../github/github-event-handler";
import { WebhookEventName } from "@octokit/webhooks-types";
import { EmitterWebhookEvent } from "@octokit/webhooks";
import { brotliCompressSync } from "node:zlib";
import { Buffer } from "node:buffer";

export interface JobResult {
  jobId: string;
  status: "completed" | "failed";
  outputs?: Record<string, unknown>;
  error?: string;
}

export interface EventPayload {
  action: string;
  installation: {
    id: number;
  };
  repository: {
    name: string;
    full_name: string;
    owner: {
      login: string;
    };
  };
  sender: {
    login: string;
  };
  [key: string]: unknown;
}

export interface CommandResponse {
  data?: Record<string, unknown>;
  error?: string;
}
const AGENT_CONFIG_REPO = ".ubiquity-os";
const AGENT_CONFIG_PATH = ".github/.ubiquity-os.agents.yml";

function compress(str: string): string {
  const input = Buffer.from(str, "utf8");
  const compressed = brotliCompressSync(new Uint8Array(input));
  return Buffer.from(compressed.buffer).toString("base64");
}

export class AgentRegistry {
  private _jobState: KvStore<AgentJobState>;
  private _agents: Map<string, Agent> = new Map();
  private _config: AgentConfiguration | null = null;
  private _jobCallbacks: Map<string, (result: JobResult) => Promise<void>> = new Map();

  constructor(jobState: KvStore<AgentJobState>) {
    this._jobState = jobState;
  }

  async loadAgents(context: GitHubContext, agentConfigOwner: string) {
    try {
      const { data } = await context.octokit.rest.repos.getContent({
        owner: agentConfigOwner,
        repo: AGENT_CONFIG_REPO,
        path: AGENT_CONFIG_PATH,
        mediaType: { format: "raw" },
      });

      const configYaml = data as unknown as string;
      const parsed = yaml.load(configYaml);
      const configWithDefaults = Value.Default(agentConfigSchema, parsed);
      const config = Value.Decode(agentConfigSchema, configWithDefaults);

      this._config = config;
      this._agents = config.agents.reduce((map, agent) => {
        map.set(agent.id, agent);
        return map;
      }, new Map<string, Agent>());
      logger.info({ agentCount: config.agents.length }, "Loaded agent configuration");
    } catch (err) {
      logger.error({ err }, "Failed to load agent configuration");
      return null;
    }
  }

  async loadAgentsFromConfig(config: AgentConfiguration): Promise<void> {
    for (const agent of config.agents) {
      this._agents.set(agent.id, agent);
      logger.info({ agentId: agent.id }, "Registered agent");
    }
  }

  async createJob(
    context: GitHubContext,
    agentId: string,
    capability: string,
    inputs: Record<string, unknown>,
    callbackUrl: string,
    signature: string,
    token: string,
    owner: string,
    progressToken?: string,
    onComplete?: (result: JobResult) => Promise<void>,
    sessionId?: string
  ): Promise<string> {
    const agent = this._agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const jobId = `${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    logger.info({ jobId, agentId, capability }, "Creating agent job");

    const agentInput = {
      stateId: jobId,
      progressToken: progressToken || "",
      eventName: context.name,
      eventPayload: context.payload,
      command: {
        name: capability,
        parameters: {
          ...inputs,
          callbackUrl,
          jobId,
        },
      },
      authToken: token,
      settings: agent.settings || {},
      ref: isGithubAgent(agent.agent) ? agent.agent.ref || "main" : "",
      signature,
    };

    const jobState: AgentJobState = {
      jobId: sessionId || jobId,
      status: "pending",
      inputs: agentInput,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this._jobState.put(jobId, jobState);
    if (onComplete) {
      this._jobCallbacks.set(jobId, onComplete);
    }
    void this._executeJob(context, agent, jobState, signature, owner);

    return jobId;
  }

  async getJobState(jobId: string): Promise<AgentJobState | null> {
    return await this._jobState.get(jobId);
  }

  async handleAgentResponse(jobId: string, response: Record<string, unknown>): Promise<void> {
    const jobState = await this._jobState.get(jobId);
    if (!jobState) {
      logger.error({ jobId }, "Job state not found for agent response");
      return;
    }

    const isFinalResponse = "data" in response;

    if (Object.keys(response).length === 0) {
      logger.warn({ jobId, response }, "Ignoring empty agent response to prevent final output overwrite.");
      return;
    }

    const newStatus = isFinalResponse ? "completed" : "running";

    if (jobState.status === "completed" && !isFinalResponse) {
      logger.warn({ jobId, response }, "Ignoring late intermediate update after job completion.");
      return;
    }

    await this._updateJobState(jobState, {
      status: newStatus,
      outputs: response,
    });

    logger.debug({ jobId, status: newStatus }, "Agent job state updated");

    if (isFinalResponse) {
      logger.info({ jobId }, "Agent job completed with final data");

      const result: JobResult = {
        jobId,
        status: "completed",
        outputs: response,
      };

      const callback = this._jobCallbacks.get(jobId);
      if (callback) {
        await callback(result);
        this._jobCallbacks.delete(jobId);
      }
    }
  }

  async handleAgentError(jobId: string, error: string): Promise<void> {
    const jobState = await this._jobState.get(jobId);
    if (!jobState) {
      logger.error({ jobId }, "Job state not found for agent error");
      return;
    }

    const result: JobResult = {
      jobId,
      status: "failed",
      error,
    };

    await this._updateJobState(jobState, {
      status: "failed",
      error,
    });

    const callback = this._jobCallbacks.get(jobId);
    if (callback) {
      await callback(result);
      this._jobCallbacks.delete(jobId);
    }
  }

  getAgents(): Map<string, Agent> {
    return this._agents;
  }

  private async _updateJobState(jobState: AgentJobState, update: Partial<AgentJobState>): Promise<void> {
    const updatedState = {
      ...jobState,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    await this._jobState.put(jobState.jobId, updatedState);
  }

  private async _buildEventPayload(context: GitHubContext, installationId: number, owner: string, repo: string): Promise<EventPayload> {
    const safeOwner = owner && typeof owner === "string" && owner.length > 0 ? owner : "unknown-owner";
    const safeRepo = repo && typeof repo === "string" && repo.length > 0 ? repo : "unknown-repo";
    return {
      action: "agent_invoked",
      installation: {
        id: installationId,
      },
      repository: {
        name: safeRepo,
        full_name: `${safeOwner}/${safeRepo}`,
        owner: {
          login: safeOwner,
        },
      },
      sender: {
        login: safeOwner,
      },
      ...Object.fromEntries(Object.entries(context.payload).filter(([key]) => key !== "repository")),
    };
  }

  private async _executeJob(context: GitHubContext, agent: Agent, jobState: AgentJobState, signature: string, owner: string) {
    try {
      await this._updateJobState(jobState, { status: "running" });

      const workflowInputs = {
        stateId: jobState.jobId,
        eventName: jobState.inputs.eventName,
        eventPayload: await this._buildEventPayload(context, parseInt(jobState.inputs.installationId as string) || 123445, owner, AGENT_CONFIG_REPO),
        command: jobState.inputs.command || {},
        authToken: jobState.inputs.authToken,
        settings: { ...agent.settings },
        ref: "http://example.com",
        signature,
        input: jobState.inputs,
      };

      const dispatchInputs = {
        ...workflowInputs,
        eventPayload: compress(JSON.stringify(workflowInputs.eventPayload)),
        command: JSON.stringify(workflowInputs.command),
        settings: JSON.stringify(workflowInputs.settings),
        input: JSON.stringify(workflowInputs.input),
      };

      if (isGithubAgent(agent.agent)) {
        await dispatchWorkflow(context, {
          owner: agent.agent.owner,
          repository: agent.agent.repo,
          workflowId: agent.agent.workflowId,
          ref: agent.agent.ref,
        });
      } else {
        logger.info({ agentUrl: agent.agent }, "Dispatching to remote agent");
        await dispatchWorker(agent.agent, dispatchInputs);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error occurred";
      logger.error({ error, jobId: jobState.jobId }, "Failed to execute agent job");
      jobState.status = "failed";
      jobState.error = error;
      await this.handleAgentError(jobState.jobId, error);
    }
  }

  async *getJobStream(jobId: string): AsyncGenerator<string, void, unknown> {
    let lastStatus: string | null = null;
    for await (const jobState of (this._jobState as AgentStateStore).watch(jobId)) {
      if (!jobState) {
        yield `data: ${JSON.stringify({ error: "Job not found" })}\n\n`;
        return;
      }
      if (jobState.status !== lastStatus) {
        lastStatus = jobState.status;
        yield `data: ${JSON.stringify({ status: jobState.status, outputs: jobState.outputs, error: jobState.error })}\n\n`;
        if (jobState.status === "completed" || jobState.status === "failed") {
          return;
        }
      }
    }
  }

  public watchJob(jobId: string): AsyncIterableIterator<AgentJobState | null> {
    if (this._jobState instanceof AgentStateStore) {
      console.log("Watching job:", jobId);
      return this._jobState.watch(jobId);
    }

    logger.warn({ jobId }, "Job watching is not supported by the current state store.");
    return (async function* () {})();
  }
}

export async function createAgentJob(
  ctx: Context,
  agentId: string,
  capability: string,
  inputs: Record<string, unknown>,
  owner: string,
  installationId: string | number
) {
  const env = Value.Decode(envSchema, Value.Default(envSchema, honoEnv(ctx))) as Env;

  const llmClient = new OpenAI({
    apiKey: env.OPENROUTER_API_KEY,
    baseURL: env.OPENROUTER_BASE_URL,
  });

  const agentStateStore = await AgentStateStore.create(env.KV_URL, ctx.var.logger);
  const agentRegistry = new AgentRegistry(agentStateStore);

  const eventHandler = new GitHubEventHandler({
    environment: env.ENVIRONMENT,
    webhookSecret: env.APP_WEBHOOK_SECRET,
    appId: env.APP_ID,
    privateKey: env.APP_PRIVATE_KEY,
    pluginChainState: new EmptyStore(ctx.var.logger),
    llmClient,
    llm: env.OPENROUTER_MODEL,
    logger: ctx.var.logger,
  });

  const url = ctx.req.url;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("Cannot determine public callback URL for agent. Please ensure the 'Host' header is set correctly.");
  }
  const baseUrl = new URL(url).origin;
  const callbackUrl = `${baseUrl}/agent/response`;

  const githubContext = new GitHubContext(
    eventHandler,
    { name: "repository_dispatch" as WebhookEventName, id: ctx.var.requestId, payload: {} } as EmitterWebhookEvent<"repository_dispatch">,
    installationId ? eventHandler.getAuthenticatedOctokit(Number(installationId)) : eventHandler.getUnauthenticatedOctokit(),
    llmClient,
    ctx.var.logger
  );

  const signature = await eventHandler.signPayload(JSON.stringify(githubContext.payload));
  const token = await eventHandler.getToken(Number(installationId));
  await agentRegistry.loadAgents(githubContext, owner);

  return agentRegistry.createJob(githubContext, agentId, capability, inputs, callbackUrl, signature, token, owner);
}
