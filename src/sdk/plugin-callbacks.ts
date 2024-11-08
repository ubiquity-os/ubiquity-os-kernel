import { Context, SupportedEventsU } from "./context";
import { CallbackFunction, PluginCallbacks } from "../types/helpers";
import { postWorkerErrorComment } from "./errors";

/**
 * Build your callbacks first and pass `CallbackBuilder` directly to `createPlugin`.
 * 
 * @example

```ts
const builder = new CallbackBuilder()
  .addCallback("issue_comment.created", <CallbackFunction<"issue_comment.created">>helloWorld)
  .addCallback("issue_comment.deleted", <CallbackFunction<"issue_comment.deleted">>goodbyeCruelWorld);
   ```
 */
export class CallbackBuilder {
  private _callbacks: PluginCallbacks = {} as PluginCallbacks;

  /**
   * Add a callback for the given event.
   *
   * @param event The event to add a callback for.
   * @param callback The callback to add.
   */
  addCallback<TEvent extends SupportedEventsU>(event: TEvent, callback: CallbackFunction<TEvent>) {
    this._callbacks[event] ??= [];
    this._callbacks[event].push(callback);
    return this;
  }

  /**
   * Add multiple callbacks for the given event.
   *
   * @param event The event to add callbacks for.
   * @param callbacks The callbacks to add.
   */
  addCallbacks<TEvent extends SupportedEventsU>(event: TEvent, callbacks: CallbackFunction<TEvent>[]) {
    this._callbacks[event] ??= [];
    this._callbacks[event].push(...callbacks);
    return this;
  }

  /**
   * This simply returns the callbacks object.
   */
  build() {
    return this._callbacks;
  }
}

export async function handlePluginCallbacks(context: Context, callbackBuilder: CallbackBuilder) {
  const { eventName } = context;
  const callbacks = callbackBuilder.build()[eventName];

  if (!callbacks || !callbacks.length) {
    context.logger.info(`No callbacks found for event ${eventName}`);
    return { status: 204, reason: "skipped" };
  }

  try {
    const res = await Promise.all(callbacks.map((callback) => handleCallback(callback, context)));
    context.logger.info(`${eventName} callbacks completed`, { res });
    let hasFailed = false;
    for (const r of res) {
      if (r.status === 500) {
        await postWorkerErrorComment(context, context.logger.error(r.reason, { content: r.content }));
        hasFailed = true;
      } else if (r.status === 404) {
        context.logger.error(r.reason, { content: r.content });
      } else if (r.status === 204) {
        context.logger.info(r.reason, { content: r.content });
      } else {
        context.logger.ok(r.reason, { content: r.content });
      }
    }

    if (hasFailed) {
      return { status: 500, reason: `One or more callbacks failed for event ${eventName}` };
    }
    return { status: 200, reason: "success" };
  } catch (er) {
    await postWorkerErrorComment(context, context.logger.fatal("Error in handlePluginCallbacks", { er }));
    return { status: 500, reason: "error", content: String(er) };
  }
}

/**
 * Why do we need this wrapper function?
 *
 * By using a generic `Function` type for the callback parameter, we bypass strict type
 * checking temporarily. This allows us to pass a standard `Context` object, which we know
 * contains the correct event and payload types, to the callback safely.
 *
 * We can trust that the `ProxyCallbacks` type has already ensured that each callback function
 * matches the expected event and payload types, so this function provides a safe and
 * flexible way to handle callbacks without introducing type or logic errors.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
function handleCallback(callback: Function, context: Context) {
  return callback(context);
}
