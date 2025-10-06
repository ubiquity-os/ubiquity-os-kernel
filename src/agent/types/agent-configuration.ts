import { StaticDecode, Type as T } from "@sinclair/typebox";
import { StandardValidator } from "typebox-validators";

export type GithubAgent = {
  owner: string;
  repo: string;
  workflowId: string;
  ref?: string;
};

const urlRegex = /^https?:\/\/\S+?$/;
const githubAgentRegex = /^([0-9a-zA-Z-._]+)\/([0-9a-zA-Z-._]+)(?::([0-9a-zA-Z-._]+))?(?:@([0-9a-zA-Z-._]+(?:\/[0-9a-zA-Z-._]+)*))?$/;

export function isGithubAgent(agent: string | GithubAgent): agent is GithubAgent {
  return typeof agent !== "string";
}

function githubAgentType() {
  return T.Transform(T.String())
    .Decode((value) => {
      if (urlRegex.test(value)) {
        return value;
      }
      const matches = value.match(githubAgentRegex);
      if (!matches) {
        throw new Error(`Invalid agent name: ${value}`);
      }
      return {
        owner: matches[1],
        repo: matches[2],
        workflowId: matches[3] || "agent.yml",
        ref: matches[4] || undefined,
      } as GithubAgent;
    })
    .Encode((value) => {
      if (typeof value === "string") {
        return value;
      }
      return `${value.owner}/${value.repo}${value.workflowId ? ":" + value.workflowId : ""}${value.ref ? "@" + value.ref : ""}`;
    });
}

export interface AgentJobState {
  jobId: string;
  sessionId?: string;
  status: "pending" | "running" | "completed" | "failed";
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  requestId?: string;
  webhookEventId?: string;
}

export interface CommandCall {
  name: string;
  parameters: unknown;
}

export interface AgentInput {
  stateId: string;
  eventName: string;
  eventPayload: Record<string, unknown>;
  command: CommandCall | null;
  authToken: string;
  settings: Record<string, unknown>;
  ref: string;
  signature: string;
}

export interface AgentCapability {
  name: string;
  description?: string;
  parameters?: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  outputs?: {
    type: "object";
    properties: Record<string, unknown>;
  };
}

export interface AgentInvocation {
  stateId: string;
  eventName: string;
  eventPayload: Record<string, unknown>;
  command: {
    name: string;
    parameters: unknown;
  };
  authToken: string;
  settings: Record<string, unknown>;
  ref: string;
  signature: string;
}

export const commandCallSchema = T.Object({
  name: T.String(),
  parameters: T.Unknown(),
});

export const agentInputSchema = T.Object({
  stateId: T.String(),
  eventName: T.String(),
  eventPayload: T.Record(T.String(), T.Unknown()),
  command: T.Union([T.Null(), commandCallSchema]),
  authToken: T.String(),
  settings: T.Record(T.String(), T.Unknown()),
  ref: T.String(),
  signature: T.String(),
});

const agentSchema = T.Object({
  id: T.String(),
  agent: githubAgentType(),
  settings: T.Optional(T.Record(T.String(), T.Unknown())),
});

export const agentConfigSchema = T.Object({
  agents: T.Array(agentSchema),
});

export const agentConfigValidator = new StandardValidator(agentConfigSchema);

export interface NextAgentConfig {
  agentId: string;
  capability: string;
  inputs?: Record<string, unknown>;
  installationId?: number;
}

export type AgentConfiguration = StaticDecode<typeof agentConfigSchema>;
export type Agent = StaticDecode<typeof agentSchema>;
