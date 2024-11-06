import { Context } from "../sdk";
import { SupportedEventsU } from "../sdk/context";

export type CallbackResult = { status: 200 | 201 | 204 | 404 | 500; reason: string; content?: string | Record<string, unknown> };
export type CallbackFunction<
    TEvent extends SupportedEventsU,
    TConfig extends unknown = unknown,
    TEnv extends unknown = unknown
> = (context: Context<TConfig, TEnv, TEvent>) => Promise<CallbackResult>;
/**
 * The `Context` type is a generic type defined as `Context<TEvent, TPayload>`,
 * where `TEvent` is a string representing the event name (e.g., "issues.labeled")
 * and `TPayload` is the webhook payload type for that event, derived from
 * the `SupportedEvents` type map.
 *
 * The `ProxyCallbacks` object is cast to allow optional callbacks
 * for each event type. This is useful because not all events may have associated callbacks.
 * As opposed to Partial<ProxyCallbacks> which could mean an undefined object.
 *
 * The expected function signature for callbacks looks like this:
 *
 * ```typescript
 * fn(context: Context<"issues.labeled", SupportedEvents["issues.labeled"]>): Promise<Result>
 * ```
 */

export type ProxyCallbacks = {
    [K in SupportedEventsU]: Array<CallbackFunction<K>>;
};
