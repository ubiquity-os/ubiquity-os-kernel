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
  get(id: string): Promise<T | null> {
    console.log(`get KV ${id}`);
    return Promise.resolve(null);
  }

  put(id: string, state: T): Promise<void> {
    console.log(`put KV ${id} ${state}`);
    return Promise.resolve();
  }
}
