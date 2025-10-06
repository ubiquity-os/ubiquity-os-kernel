import { AgentJobState } from "../../agent/types/agent-configuration";
import { logger } from "../../logger/logger";

/**
 * KvStore is an interface representing a simple key-value store.
 *
 * @template T - The type of the value to be stored and retrieved.
 */
export interface KvStore<T> {
  get(id: string): Promise<T | null>;
  put(id: string, state: T): Promise<void>;
}

/**
 * CloudflareKv is a class that provides an interface to interact with
 * Cloudflare KV (Key-Value) storage.
 *
 * It implements the KvStore interface to handle generic types.
 *
 * @template T - The type of the values being stored.
 */
// export class CloudflareKv<T> implements KvStore<T> {
//   private _kv: KVNamespace;
//
//   constructor(kv: KVNamespace) {
//     this._kv = kv;
//   }
//
//   get(id: string): Promise<T | null> {
//     return this._kv.get(id, "json");
//   }
//
//   put(id: string, state: T): Promise<void> {
//     return this._kv.put(id, JSON.stringify(state));
//   }
// }

/**
 * A class that implements the KvStore interface, representing an empty key-value store.
 * All get operations return null and put operations do nothing, but log the action.
 *
 * @template T - The type of values to be stored.
 */
export class EmptyStore<T> implements KvStore<T> {
  constructor(protected _logger = logger) {}

  get(id: string): Promise<T | null> {
    this._logger.debug({ id }, "kv get");
    return Promise.resolve(null);
  }

  put(id: string, state: T): Promise<void> {
    this._logger.debug({ id, state }, "kv put");
    return Promise.resolve();
  }
}

export class AgentStateStore implements KvStore<AgentJobState> {
  private _kv: Deno.Kv;
  private _prefix: string;

  private constructor(
    kv: Deno.Kv,
    protected _logger = logger,
    prefix: string = "agent:"
  ) {
    this._kv = kv;
    this._prefix = prefix;
  }

  static async create(kvUrl: string, loggerInstance = logger, prefix: string = "agent:") {
    logger.info({ kv: kvUrl || "undefined" }, "Creating AgentStateStore");
    const kv = await Deno.openKv();
    return new AgentStateStore(kv, loggerInstance, prefix);
  }

  async get(id: string): Promise<AgentJobState | null> {
    this._logger.debug({ id }, "kv get");
    const result = await this._kv.get<AgentJobState>([this._prefix, id]);
    return result.value || null;
  }

  async put(id: string, state: AgentJobState, expireIn: number = 180000): Promise<void> {
    this._logger.info({ kv: this._kv || "undefined" }, "Putting to kv");
    await this._kv.set([this._prefix, id], state, { expireIn });
  }

  /**
   * Watches for changes to a specific job state in the KV store.
   *
   * @param id The ID of the job to watch.
   * @returns An async iterable iterator that yields the job state whenever it changes.
   */
  async *watch(id: string): AsyncIterableIterator<AgentJobState | null> {
    const watcher = this._kv.watch([[this._prefix, id]]);
    for await (const entry of watcher) {
      console.log("Detected change in job state for id:", id);
      // The entry is an array of KvEntry, but we are only watching one key
      const jobStateEntry = entry[0];
      if (jobStateEntry) {
        console.log("Job state changed:", jobStateEntry.value);
        yield jobStateEntry.value as AgentJobState | null;
      }
    }
  }
}
