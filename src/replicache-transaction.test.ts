import {expect} from 'chai';
import {compareUTF8} from 'compare-utf8';
import {test} from 'mocha';
import type {JSONValue, ScanOptions} from 'replicache';
import {ReplicacheTransaction, Storage} from './replicache-transaction.js';

class MemStorage implements Storage {
  #map = new Map<string, JSONValue>();

  // eslint-disable-next-line require-await
  async putEntry(key: string, value: JSONValue): Promise<void> {
    this.#map.set(key, value);
  }

  // eslint-disable-next-line require-await
  async hasEntry(key: string): Promise<boolean> {
    return this.#map.has(key);
  }

  // eslint-disable-next-line require-await
  async getEntry(key: string): Promise<JSONValue | undefined> {
    return this.#map.get(key);
  }

  async *getEntries(
    fromKey: string,
  ): AsyncIterable<readonly [string, JSONValue]> {
    const entries = this.getAllEntries();
    for (const entry of entries) {
      const [k] = entry;
      if (k >= fromKey) {
        yield entry;
      }
    }
  }

  getAllEntries(): [string, JSONValue][] {
    const entries = [...this.#map.entries()];
    entries.sort(([a], [b]) => compareUTF8(a, b));
    return entries;
  }

  clear() {
    this.#map.clear();
  }

  // eslint-disable-next-line require-await
  async delEntry(key: string): Promise<void> {
    this.#map.delete(key);
  }
}

test('ReplicacheTransaction', async () => {
  const s = new MemStorage();
  const t1 = new ReplicacheTransaction(s, 'c1');

  expect(t1.clientID).equal('c1');
  expect(t1.environment).equal('server');
  expect(t1.reason).equal('authoritative');
  expect(await t1.has('foo')).false;
  expect(await t1.get('foo')).undefined;

  await t1.put('foo', 'bar');
  expect(await t1.has('foo')).true;
  expect(await t1.get('foo')).equal('bar');

  await t1.flush();

  expect(await s.getEntry('foo')).equal('bar');

  const t2 = new ReplicacheTransaction(s);
  await t2.del('foo');
  await t2.flush();

  expect(await s.getEntry('foo')).equal(undefined);
  expect(s.getAllEntries()).deep.equal([]);

  t1.clientID = 'c2';
  expect(t1.clientID).equals('c2');
});

test('ReplicacheTransaction overlap', async () => {
  const s = new MemStorage();
  const t1 = new ReplicacheTransaction(s);
  await t1.put('foo', 'bar');

  const t2 = new ReplicacheTransaction(s);
  expect(await t2.has('foo')).false;

  await t1.flush();
  expect(await t2.has('foo')).false;

  const t3 = new ReplicacheTransaction(s);
  expect(await t3.has('foo')).true;
});

test('ReplicacheTransaction scan', async () => {
  const s = new MemStorage();

  async function putEntries(entries: string[]) {
    for (const entry of entries) {
      await s.putEntry(entry, entry);
    }
  }

  async function test(
    sources: string[],
    changes: string[],
    scanOpts: ScanOptions,
    expected: string[],
  ) {
    s.clear();
    await putEntries(sources);

    const t = new ReplicacheTransaction(s);
    for (const change of changes) {
      await t.put(change, change);
    }
    await t.flush();
    const results = await t.scan(scanOpts).keys().toArray();
    expect(results).deep.equal(expected);
  }
  await test(['a'], ['b'], {}, ['a', 'b']);
  await test(['a', 'c'], ['b', 'd'], {start: {key: 'c'}}, ['c', 'd']);
  await test(['a', 'b'], ['bb', 'c'], {prefix: 'b'}, ['b', 'bb']);
  await test(['a', 'b'], ['bb', 'c'], {prefix: 'b', limit: 1}, ['b']);
  // From compare-utf8 package -- ensure we sorting by utf98
  await test(['\uFF3A', '\u005A'], [], {}, ['\u005A', '\uFF3A']);
  await test(['\u{1D655}', '\uFF3A'], [], {}, ['\uFF3A', '\u{1D655}']);
  await test(['\u{1D655}', '\u005A'], [], {}, ['\u005A', '\u{1D655}']);
  await test(['\uFF3A'], ['\u005A'], {}, ['\u005A', '\uFF3A']);
  await test(['\u{1D655}'], ['\uFF3A'], {}, ['\uFF3A', '\u{1D655}']);
  await test(['\u{1D655}'], ['\u005A'], {}, ['\u005A', '\u{1D655}']);
  await test([], ['\uFF3A', '\u005A'], {}, ['\u005A', '\uFF3A']);
  await test([], ['\u{1D655}', '\uFF3A'], {}, ['\uFF3A', '\u{1D655}']);
  await test([], ['\u{1D655}', '\u005A'], {}, ['\u005A', '\u{1D655}']);
});
