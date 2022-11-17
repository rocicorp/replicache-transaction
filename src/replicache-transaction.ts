import {
  isScanIndexOptions,
  makeScanResult,
  ScanNoIndexOptions,
  ScanOptions,
  WriteTransaction,
  mergeAsyncIterables,
  filterAsyncIterable,
  ReadonlyJSONValue,
} from "replicache";

import { compareUTF8 } from "compare-utf8";

type CacheMap = Map<
  string,
  { value: ReadonlyJSONValue | undefined; dirty: boolean }
>;

export interface Storage {
  putEntry(key: string, value: ReadonlyJSONValue): Promise<void>;
  hasEntry(key: string): Promise<boolean>;
  getEntry(key: string): Promise<ReadonlyJSONValue | undefined>;
  getEntries(
    fromKey: string
  ): AsyncIterable<readonly [string, ReadonlyJSONValue]>;
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

  async put(key: string, value: ReadonlyJSONValue): Promise<void> {
    this._cache.set(key, { value, dirty: true });
  }
  async del(key: string): Promise<boolean> {
    const had = await this.has(key);
    this._cache.set(key, { value: undefined, dirty: true });
    return had;
  }
  async get(key: string): Promise<ReadonlyJSONValue | undefined> {
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

    return makeScanResult<ScanNoIndexOptions>(options, (fromKey: string) => {
      const source = storage.getEntries(fromKey);
      const pending = getCacheEntries(cache, fromKey);
      const merged = mergeAsyncIterables(source, pending, entryCompare);
      const filtered = filterAsyncIterable(
        merged,
        (entry: readonly [string, ReadonlyJSONValue | undefined]) =>
          entry[1] !== undefined
      ) as AsyncIterable<readonly [string, ReadonlyJSONValue]>;
      return filtered;
    });
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
): Iterable<readonly [string, ReadonlyJSONValue | undefined]> {
  const entries = [];
  for (const [key, { value, dirty }] of cache) {
    if (dirty && compareUTF8(key, fromKey) >= 0) {
      entries.push([key, value] as const);
    }
  }
  entries.sort((a, b) => compareUTF8(a[0], b[0]));
  return entries;
}

export function entryCompare(
  a: readonly [string, unknown],
  b: readonly [string, unknown]
): number {
  return compareUTF8(a[0], b[0]);
}
