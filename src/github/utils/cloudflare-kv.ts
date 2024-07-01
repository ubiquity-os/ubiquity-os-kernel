export class CloudflareKv<T> {
  private _kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this._kv = kv;
  }

  get(id: string): Promise<T | null> {
    return this._kv.get(id, "json");
  }

  put(id: string, state: T): Promise<void> {
    return this._kv.put(id, JSON.stringify(state));
  }
}
