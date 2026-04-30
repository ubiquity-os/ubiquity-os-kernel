import { EmitterWebhookEventName } from "@octokit/webhooks";
import { Webhooks } from "@octokit/webhooks";
import { GitHubContext } from "../github-context.ts";
import { SimplifiedContext } from "../github-context.ts";

/**
 * Plugin invocation type - determines how the plugin is dispatched
 * - "action": Dispatch via GitHub Actions workflow
 * - "worker": Dispatch via HTTP worker endpoint
 * - "auto": SDK decides based on manifest (default)
 */
export type PluginInvocationType = "action" | "worker" | "auto";

/**
 * Event handler callback function
 */
export type EventHandlerFn<T extends EmitterWebhookEventName = EmitterWebhookEventName> = (
  context: GitHubContext<T>
) => Promise<void> | void;

/**
 * Handler descriptor for SDK-style API
 */
export interface HandlerDescriptor<T extends EmitterWebhookEventName = EmitterWebhookEventName> {
  event: T;
  invocationType: PluginInvocationType;
  handler: EventHandlerFn<T>;
}

/**
 * SDK-style event handlers builder
 * Provides fluent API for registering handlers with invocation type hints
 *
 * @example
 * ```ts
 * const handlers = new SdkStyleEventHandlers()
 *   .on("issue_comment.created", "action", handler1)
 *   .on("issue.closed", "worker", handler2)
 *   .on("push", "auto", handler3);
 * ```
 */
export class SdkStyleEventHandlers {
  private _handlers: HandlerDescriptor[] = [];

  /**
   * Register an event handler with an invocation type
   * @param event - GitHub webhook event name
   * @param invocationType - How the plugin should be dispatched ("action", "worker", or "auto")
   * @param handler - Callback function to execute
   */
  on<T extends EmitterWebhookEventName>(
    event: T,
    invocationType: PluginInvocationType,
    handler: EventHandlerFn<T>
  ): this {
    this._handlers.push({
      event,
      invocationType,
      handler,
    });
    return this;
  }

  /**
   * Register an action-type handler (dispatch via GitHub Actions workflow)
   */
  action<T extends EmitterWebhookEventName>(event: T, handler: EventHandlerFn<T>): this {
    return this.on(event, "action", handler);
  }

  /**
   * Register a worker-type handler (dispatch via HTTP endpoint)
   */
  worker<T extends EmitterWebhookEventName>(event: T, handler: EventHandlerFn<T>): this {
    return this.on(event, "worker", handler);
  }

  /**
   * Register an auto-type handler (SDK decides based on manifest)
   */
  auto<T extends EmitterWebhookEventName>(event: T, handler: EventHandlerFn<T>): this {
    return this.on(event, "auto", handler);
  }

  /**
   * Get all registered handlers
   */
  get handlers(): ReadonlyArray<HandlerDescriptor> {
    return this._handlers;
  }

  /**
   * Get handlers for a specific event
   */
  getHandlersForEvent(event: EmitterWebhookEventName): HandlerDescriptor[] {
    return this._handlers.filter((h) => h.event === event);
  }

  /**
   * Check if there are any handlers registered
   */
  get isEmpty(): boolean {
    return this._handlers.length === 0;
  }

  /**
   * Merge another SdkStyleEventHandlers instance into this one
   */
  merge(other: SdkStyleEventHandlers): this {
    for (const handler of other.handlers) {
      this._handlers.push(handler);
    }
    return this;
  }

  /**
   * Convert to a plain object for serialization/manifest generation
   */
  toManifestData(): { events: string[]; invocationTypes: Record<string, PluginInvocationType> } {
    const events = new Set<string>();
    const invocationTypes: Record<string, PluginInvocationType> = {};

    for (const h of this._handlers) {
      const eventKey = String(h.event);
      events.add(eventKey);
      // Use most specific (non-auto) type if multiple handlers for same event
      if (h.invocationType !== "auto") {
        invocationTypes[eventKey] = h.invocationType;
      } else if (!invocationTypes[eventKey]) {
        invocationTypes[eventKey] = "auto";
      }
    }

    return {
      events: Array.from(events),
      invocationTypes,
    };
  }
}

/**
 * Creates a merged handler that supports both SDK-style and traditional webhooks
 * @param handlers - SDK-style event handlers
 * @param webhooks - Octokit Webhooks instance for traditional handlers
 */
export function createUnifiedHandler(
  handlers: SdkStyleEventHandlers,
  webhooks: Webhooks<SimplifiedContext>
): {
  on: Webhooks<SimplifiedContext>["on"];
  getHandlers: () => HandlerDescriptor[];
} {
  return {
    on: webhooks.on.bind(webhooks),
    getHandlers: () => handlers.handlers,
  };
}

/**
 * Extract invocation type from manifest or handler configuration
 * @param manifest - Plugin manifest
 * @param event - Event name
 * @param handlers - Handler descriptors for this event
 */
export function resolveInvocationType(
  manifest: { homepage_url?: string; invocationType?: PluginInvocationType } | null,
  event: string,
  handlers: HandlerDescriptor[]
): PluginInvocationType {
  // Check if any handler specifies a non-auto type
  const handlerWithType = handlers.find((h) => h.invocationType !== "auto");
  if (handlerWithType) {
    return handlerWithType.invocationType;
  }

  // Fall back to manifest or default
  if (manifest?.homepage_url) {
    return "worker";
  }

  return "action";
}