import type { EmitterWebhookEvent } from "@octokit/webhooks";

type WebhookTransform<TContext> = (event: EmitterWebhookEvent) => TContext;

type ContextHandler<TContext> = (context: TContext) => unknown | Promise<unknown>;

type AnyHandler = (event: EmitterWebhookEvent) => unknown | Promise<unknown>;

type ErrorHandler = (error: unknown) => unknown | Promise<unknown>;

function getEventKey(event: EmitterWebhookEvent): string {
  const payload = event.payload as { action?: unknown };
  const action = typeof payload?.action === "string" ? payload.action : null;
  return action ? `${event.name}.${action}` : String(event.name);
}

export class FakeWebhooks<TContext> {
  private readonly _transform: WebhookTransform<TContext>;
  private readonly _handlers = new Map<string, Array<ContextHandler<TContext>>>();
  private readonly _anyHandlers: Array<AnyHandler> = [];
  private readonly _errorHandlers: Array<ErrorHandler> = [];

  constructor(options: { secret: string; transform: WebhookTransform<TContext> }) {
    this._transform = options.transform;
  }

  on = (eventName: string, handler: ContextHandler<TContext>) => {
    const existing = this._handlers.get(eventName) ?? [];
    existing.push(handler);
    this._handlers.set(eventName, existing);
  };

  onAny = (handler: AnyHandler) => {
    this._anyHandlers.push(handler);
  };

  onError = (handler: ErrorHandler) => {
    this._errorHandlers.push(handler);
  };

  async receive(event: EmitterWebhookEvent) {
    try {
      for (const handler of this._anyHandlers) {
        await handler(event);
      }

      const key = getEventKey(event);
      const context = this._transform(event);
      const handlers = this._handlers.get(key) ?? [];
      for (const handler of handlers) {
        await handler(context);
      }
    } catch (error) {
      for (const handler of this._errorHandlers) {
        await handler(error);
      }
      throw error;
    }
  }
}
