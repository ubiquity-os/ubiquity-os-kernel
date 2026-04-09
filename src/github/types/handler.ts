import { EmitterWebhookEventName } from "@octokit/webhooks";
import { Context } from "@ubiquity-os/plugin-sdk/context";

/**
 * Handler type: "action" dispatches to GitHub Actions, "worker" runs as CF Worker
 */
export type HandlerType = "action" | "worker";

/**
 * Event handler function signature
 */
export type EventHandler<TConfig = unknown, TEnv = unknown, TCommand = unknown, TSupportedEvents extends EmitterWebhookEventName = EmitterWebhookEventName> = (
  context: Context<TConfig, TEnv, TCommand, TSupportedEvents>
) => unknown | Promise<unknown>;

/**
 * Registration for a single event handler
 */
export type HandlerRegistration = {
  event: string;
  type: HandlerType;
  handler: EventHandler;
  /** Optional: action ref (owner/repo/workflowId@ref) for action handlers */
  actionRef?: string;
  /** Optional: fine-grained GitHub token for action forwarding */
  token?: string;
};

/**
 * Built plugin definition
 */
export type PluginDefinition = {
  handlers: HandlerRegistration[];
};

/**
 * Resolves the handler type for an event, checking ACTION_REF and environment
 */
export function resolveHandlerType(event: string, explicitType?: HandlerType): HandlerType {
  if (explicitType) return explicitType;

  // Auto-detect: if ACTION_REF is set in environment, this event should be forwarded to an Action
  try {
    const actionRef = Deno.env.get("ACTION_REF");
    if (actionRef) {
      return "action";
    }
  } catch {
    // Deno not available
  }

  return "worker";
}

/**
 * Auto-detect ACTION_REF from environment or manifest
 */
export function detectActionRef(): string | undefined {
  try {
    return Deno.env.get("ACTION_REF") ?? undefined;
  } catch {
    return undefined;
  }
}
