import { Context, SupportedEventsU } from "../sdk/context";
import { CallbackFunction, ProxyCallbacks } from "../types/helpers";
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
    private callbacks: ProxyCallbacks = {} as ProxyCallbacks;

    /**
     * Add a callback for the given event.
     * 
     * @param event The event to add a callback for.
     * @param callback The callback to add.
     */
    addCallback<TEvent extends SupportedEventsU>(event: TEvent, callback: CallbackFunction<TEvent>) {
        this.callbacks[event] ??= [];
        this.callbacks[event].push(callback)
        return this;
    }

    /**
     * This simply returns the callbacks object.
     */
    build() {
        return this.callbacks;
    }
}

export function proxyCallbacks(context: Context, callbackBuilder: CallbackBuilder): ProxyCallbacks {
    return new Proxy(callbackBuilder.build(), {
        get(target, prop: SupportedEventsU) {
            if (!target[prop]) {
                context.logger.info(`No callbacks found for event ${prop}`);
                return { status: 204, reason: "skipped" };
            }
            return (async () => {
                try {
                    const res = await Promise.all(target[prop].map((callback) => handleCallback(callback, context)));
                    context.logger.info(`${prop} callbacks completed`, { res });
                    let failed = false;
                    for (const r of res) {
                        if (r.status === 500) {
                            /**
                             * Once https://github.com/ubiquity-os/ubiquity-os-kernel/pull/169 is merged,
                             * we'll be able to detect easily if it's a worker or an action using the new context var
                             * `pluginDeploymentDetails` which is just `inputs.ref` essentially. 
                             */
                            await postWorkerErrorComment(context, context.logger.error(r.reason, { content: r.content }));
                            failed = true;
                        } else if (r.status === 404) {
                            context.logger.error(r.reason, { content: r.content });
                        } else if (r.status === 204) {
                            context.logger.info(r.reason, { content: r.content });
                        } else {
                            context.logger.ok(r.reason, { content: r.content });
                        }
                    }

                    if (failed) {
                        return { status: 500, reason: `One or more callbacks failed for event ${prop}` }
                    }
                    return { status: 200, reason: "success" };
                } catch (er) {
                    await postWorkerErrorComment(context, context.logger.error(String(er), { er }));
                    return { status: 500, reason: "error", content: String(er) };
                }
            })();
        },
    });
}

/**
 * Helper for awaiting proxyCallbacks
 */
export async function handleProxyCallbacks(proxyCallbacks: ProxyCallbacks, context: Context) {
    return proxyCallbacks[context.eventName]
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
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function handleCallback(callback: Function, context: Context) {
    return callback(context);
}
