import {
  isScanIndexOptions,
  JSONValue,
  makeScanResult,
  ScanNoIndexOptions,
  ScanOptions,
  WriteTransaction,
  mergeAsyncIterables,
  filterAsyncIterable,
} from "replicache";

type CacheMap = Map<string, { value: JSONValue | undefined; dirty: boolean }>;

export interface Storage {
  putEntry(key: string, value: JSONValue): Promise<void>;
  hasEntry(key: string): Promise<boolean>;
  getEntry(key: string): Promise<JSONValue | undefined>;
  getEntries(fromKey: string): AsyncIterable<readonly [string, JSONValue]>;
  delEntry(key: string): Promise<void>;
}

/**
 * Implements Replicache's WriteTransaction interface in terms of a Postgres
 * transaction.
 */
export class ReplicacheTransaction implements WriteTransaction {
  private _clientID: string;
  private _storage: Storage;
  private _cache: CacheMap = new Map();

  constructor(storage: Storage, clientID: string) {
    this._storage = storage;
    this._clientID = clientID;
  }

  get clientID(): string {
    return this._clientID;
  }

  async put(key: string, value: JSONValue): Promise<void> {
    this._cache.set(key, { value, dirty: true });
  }
  async del(key: string): Promise<boolean> {
    const had = await this.has(key);
    this._cache.set(key, { value: undefined, dirty: true });
    return had;
  }
  async get(key: string): Promise<JSONValue | undefined> {
    const entry = this._cache.get(key);
    if (entry) {
      return entry.value;
    }
    const value = await this._storage.getEntry(key);
    this._cache.set(key, { value, dirty: false });
    return value;
  }
  async has(key: string): Promise<boolean> {
    const val = await this.get(key);
    return val !== undefined;
  }

  async isEmpty(): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of this.scan()) {
      return false;
    }
    return true;
  }

  scan(options: ScanOptions = {} as ScanNoIndexOptions) {
    if (isScanIndexOptions(options)) {
      throw new Error("not implemented");
    }

    const { _storage: storage, _cache: cache } = this;

    return makeScanResult<ScanNoIndexOptions, JSONValue>(
      options,
      (fromKey: string) => {
        const source = storage.getEntries(fromKey);
        const pending = getCacheEntries(cache, fromKey);
        const merged = mergeAsyncIterables(source, pending, entryCompare);
        const filtered = filterAsyncIterable(
          merged,
          (entry: any) => entry[1] !== undefined
        ) as AsyncIterable<readonly [string, JSONValue]>;
        return filtered;
      }
    );
  }

  async flush(): Promise<void> {
    await Promise.all(
      [...this._cache.entries()]
        .filter(([, { dirty }]) => dirty)
        .map(([k, { value }]) => {
          if (value === undefined) {
            return this._storage.delEntry(k);
          } else {
            return this._storage.putEntry(k, value);
          }
        })
    );
  }
}

function getCacheEntries(
  cache: CacheMap,
  fromKey: string
): Iterable<readonly [string, JSONValue | undefined]> {
  const entries = [];
  for (const [key, { value, dirty }] of cache) {
    if (dirty && stringCompare(key, fromKey) >= 0) {
      entries.push([key, value] as const);
    }
  }
  entries.sort((a, b) => stringCompare(a[0], b[0]));
  return entries;
}

// TODO: use compare-utf8 instead.
export function stringCompare(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function entryCompare(
  a: readonly [string, unknown],
  b: readonly [string, unknown]
): number {
  return stringCompare(a[0], b[0]);
}
