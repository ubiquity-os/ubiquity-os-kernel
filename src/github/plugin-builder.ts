import { EmitterWebhookEventName } from "@octokit/webhooks";
import {
  EventHandler,
  HandlerRegistration,
  HandlerType,
  PluginDefinition,
  resolveHandlerType,
  detectActionRef,
} from "./types/handler.ts";

/**
 * PluginBuilder provides a fluent API for registering event handlers.
 *
 * Supports both "action" (GitHub Actions) and "worker" (CF Workers) handler types.
 *
 * @example
 * ```typescript
 * const plugin = createPlugin("my-plugin")
 *   .on("issue_comment.created", "action", handleComment)
 *   .on("issue.closed", "worker", handleClosed)
 *   .build();
 * ```
 */
export class PluginBuilder {
  private readonly _name: string;
  private readonly _handlers: Map<string, HandlerRegistration> = new Map();

  constructor(name: string) {
    this._name = name;
  }

  /**
   * Register an event handler.
   *
   * @param event - The GitHub webhook event name (e.g. "issue_comment.created")
   * @param type - Handler type: "action" for GitHub Actions, "worker" for CF Workers.
   *               If omitted, auto-detected from ACTION_REF environment variable.
   * @param handler - The function to execute when this event is received
   * @param options - Optional configuration: actionRef, token
   */
  on(
    event: string,
    type: HandlerType | undefined,
    handler: EventHandler,
    options?: { actionRef?: string; token?: string }
  ): this {
    const resolvedType = resolveHandlerType(event, type);
    const actionRef = options?.actionRef ?? (resolvedType === "action" ? detectActionRef() : undefined);

    const registration: HandlerRegistration = {
      event,
      type: resolvedType,
      handler,
      actionRef,
      token: options?.token,
    };

    this._handlers.set(event, registration);
    return this;
  }

  /**
   * Register an action handler (convenience method)
   */
  onAction(event: string, handler: EventHandler, options?: { actionRef?: string; token?: string }): this {
    return this.on(event, "action", handler, options);
  }

  /**
   * Register a worker handler (convenience method)
   */
  onWorker(event: string, handler: EventHandler): this {
    return this.on(event, "worker", handler);
  }

  /**
   * Build the final plugin definition
   */
  build(): PluginDefinition {
    return {
      handlers: Array.from(this._handlers.values()),
    };
  }

  /** Get the plugin name */
  get name(): string {
    return this._name;
  }

  /** Get registered handlers */
  get handlers(): ReadonlyMap<string, HandlerRegistration> {
    return this._handlers;
  }
}

/**
 * Create a new PluginBuilder with the given name.
 *
 * This is the unified entry point that replaces both `createPlugin` and `createActionsPlugin`.
 * The `.on()` method accepts a handler type ("action" | "worker") to determine dispatch behavior.
 *
 * @example
 * ```typescript
 * const app = createPlugin("my-plugin")
 *   .on("issue_comment.created", "action", async (ctx) => {
 *     // Handle as GitHub Action
 *   })
 *   .on("issues.opened", "worker", async (ctx) => {
 *     // Handle as CF Worker
 *   })
 *   .build();
 * ```
 */
export function createPluginBuilder(name: string): PluginBuilder {
  return new PluginBuilder(name);
}
