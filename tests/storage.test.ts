import { beforeEach, describe, expect, it } from 'vitest';
import { deleteRun, loadRun, loadRunList, loadRuns, saveRun, type Run } from '../src/storage';

/**
 * A small in-memory IndexedDB: enough of the API for storage.ts (versioned open with upgrade,
 * object stores keyed by `id`, put/get/getAll/delete/openCursor, transaction completion).
 * Values are structured-cloned on the way in and out, as the real thing does.
 */
type Store = Map<string, unknown>;
interface FakeDb { version: number; stores: Map<string, Store> }
const databases = new Map<string, FakeDb>();
const log: string[] = [];

function fakeIndexedDB() {
  const makeTx = (db: FakeDb, onDone: () => void) => {
    let pending = 0;
    let finished = false;
    const tx: any = { error: null, oncomplete: null, onerror: null, onabort: null };
    const settle = () => queueMicrotask(() => {
      if (pending === 0 && !finished) { finished = true; tx.oncomplete?.(); onDone(); }
    });
    const request = <T>(compute: () => T) => {
      const req: any = { result: undefined, onsuccess: null };
      pending++;
      queueMicrotask(() => { req.result = compute(); req.onsuccess?.(); pending--; settle(); });
      return req;
    };
    tx.objectStore = (name: string) => {
      const store = db.stores.get(name);
      if (!store) throw new Error(`NotFoundError: ${name}`);
      return {
        put: (v: any) => request(() => { log.push(`put ${name}`); store.set(v.id, structuredClone(v)); }),
        delete: (id: string) => request(() => { store.delete(id); }),
        get: (id: string) => request(() => { log.push(`get ${name}`); return structuredClone(store.get(id)); }),
        getAll: () => request(() => { log.push(`getAll ${name}`); return [...store.values()].map((v) => structuredClone(v)); }),
        openCursor: () => {
          const keys = [...store.keys()];
          let i = 0;
          const req: any = { result: null, onsuccess: null };
          const step = () => {
            pending++;
            queueMicrotask(() => {
              req.result = i < keys.length ? { value: structuredClone(store.get(keys[i])), continue: () => { i++; step(); } } : null;
              req.onsuccess?.();
              pending--;
              settle();
            });
          };
          step();
          return req;
        },
      };
    };
    settle();
    return tx;
  };
  return {
    open(name: string, version: number) {
      const req: any = { result: null, transaction: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        let db = databases.get(name);
        if (!db) { db = { version: 0, stores: new Map() }; databases.set(name, db); }
        const handle = {
          objectStoreNames: { contains: (n: string) => db!.stores.has(n) },
          createObjectStore: (n: string) => { db!.stores.set(n, new Map()); return req.transaction.objectStore(n); },
          transaction: (_names: string[], _mode: string) => makeTx(db!, () => {}),
          close: () => {},
          onversionchange: null,
        };
        req.result = handle;
        if (db.version < version) {
          log.push(`upgrade ${db.version}->${version}`);
          req.transaction = makeTx(db, () => { db!.version = version; req.transaction = null; req.onsuccess?.(); });
          req.onupgradeneeded?.();
        } else {
          req.onsuccess?.();
        }
      });
      return req;
    },
  };
}

const run = (id: string, importedAt: number, events = 2, extra: Partial<Run> = {}): Run => ({
  id, name: `${id}.json`, importedAt, bytes: 1000 + importedAt, format: 'atif', diagnostics: [],
  session: {
    id: `session-${id}`, format: 'atif', meta: { model: 'demo' },
    events: Array.from({ length: events }, (_, idx) => ({ idx, id: `e${idx}`, actor: 'assistant' as const, kind: 'message' as const, text: `synthetic ${idx}` })),
  },
  ...extra,
});

beforeEach(() => {
  databases.clear();
  log.length = 0;
  (globalThis as any).indexedDB = fakeIndexedDB();
});

describe('run storage', () => {
  it('lists summaries newest first without reading any session', async () => {
    await saveRun(run('a', 1, 3));
    await saveRun(run('b', 5, 7, { demo: true }));
    await saveRun(run('c', 3));
    log.length = 0;
    const list = await loadRunList();
    expect(list).toEqual([
      { id: 'b', name: 'b.json', importedAt: 5, bytes: 1005, format: 'atif', eventCount: 7, demo: true },
      { id: 'c', name: 'c.json', importedAt: 3, bytes: 1003, format: 'atif', eventCount: 2 },
      { id: 'a', name: 'a.json', importedAt: 1, bytes: 1001, format: 'atif', eventCount: 3 },
    ]);
    expect(log).toEqual(['getAll summaries']);
    expect(JSON.stringify(list)).not.toContain('synthetic');
  });

  it('loads exactly one run on demand', async () => {
    await saveRun(run('a', 1));
    await saveRun(run('b', 2, 4));
    log.length = 0;
    expect(await loadRun('b')).toEqual(run('b', 2, 4));
    expect(log).toEqual(['get runs']);
    expect(await loadRun('missing')).toBeUndefined();
  });

  it('keeps the existing API working: loadRuns, overwrite on save, delete from both stores', async () => {
    await saveRun(run('a', 1));
    await saveRun(run('b', 2));
    await saveRun(run('a', 9, 5)); // re-save replaces, never duplicates
    expect((await loadRuns()).map((r) => [r.id, r.session.events.length])).toEqual([['a', 5], ['b', 2]]);
    expect((await loadRunList()).map((r) => [r.id, r.eventCount])).toEqual([['a', 5], ['b', 2]]);
    await deleteRun('a');
    expect((await loadRunList()).map((r) => r.id)).toEqual(['b']);
    expect(await loadRun('a')).toBeUndefined();
    expect((await loadRuns()).map((r) => r.id)).toEqual(['b']);
  });

  it('migrates a version 1 database without losing or rewriting saved runs', async () => {
    const saved = [run('old1', 10, 6), run('old2', 20, 1)];
    databases.set('unroll-local', { version: 1, stores: new Map([['runs', new Map(saved.map((r) => [r.id, structuredClone(r)] as [string, unknown]))]]) });
    const list = await loadRunList();
    expect(log.filter((l) => l.startsWith('upgrade'))).toEqual(['upgrade 1->2']);
    expect(log).not.toContain('put runs'); // existing content is only read
    expect(list.map((r) => [r.id, r.eventCount])).toEqual([['old2', 1], ['old1', 6]]);
    expect(await loadRun('old1')).toEqual(saved[0]);
    expect(await loadRuns()).toEqual([saved[1], saved[0]]);
    log.length = 0;
    await loadRunList();
    expect(log).toEqual(['getAll summaries']); // the upgrade runs once
  });

  it('survives a damaged saved record during migration', async () => {
    const good = run('good', 2);
    const store = new Map<string, unknown>([['broken', { id: 'broken', name: 'broken.json', importedAt: 1, bytes: 5, format: 'atif' }], ['junk', 42], ['good', good]]);
    databases.set('unroll-local', { version: 1, stores: new Map([['runs', store]]) });
    expect((await loadRunList()).map((r) => [r.id, r.eventCount])).toEqual([['good', 2], ['broken', 0]]);
    expect(store.size).toBe(3); // nothing was deleted
  });

  it('creates both stores on a fresh browser', async () => {
    expect(await loadRunList()).toEqual([]);
    expect(await loadRuns()).toEqual([]);
    expect([...databases.get('unroll-local')!.stores.keys()].sort()).toEqual(['runs', 'summaries']);
  });
});
