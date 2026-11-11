import type { Session, Diag } from "./parse/types";
import type { ChatThread } from "./chat/types";

export type Run = {
  id: string;
  name: string;
  importedAt: number;
  bytes: number;
  format: string;
  session: Session;
  diagnostics: Diag[];
  fingerprint?: string;
  originalText?: string;
  originalName?: string;
  demo?: boolean;
};
/** What a run list needs. Kept in its own small store so listing never loads a session. */
export type RunSummary = {
  id: string;
  name: string;
  importedAt: number;
  bytes: number;
  format: string;
  eventCount: number;
  fingerprint?: string;
  demo?: boolean;
};

const DB = "unroll-local";
const VERSION = 3;
const RUNS = "runs";
const SUMMARIES = "summaries";
const CHATS = "chats";

export function summarize(run: Run): RunSummary {
  const summary: RunSummary = {
    id: run.id,
    name: run.name,
    importedAt: run.importedAt,
    bytes: run.bytes,
    format: run.format,
    eventCount: run.session?.events?.length ?? 0,
  };
  if (run.demo) summary.demo = true;
  if (run.fingerprint) summary.fingerprint = run.fingerprint;
  return summary;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(CHATS))
        db.createObjectStore(CHATS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(RUNS))
        db.createObjectStore(RUNS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SUMMARIES)) {
        const summaries = db.createObjectStore(SUMMARIES, { keyPath: "id" });
        // v1 → v2: index the runs already saved. Saved runs are only read, never rewritten, and the
        // cursor holds one run in memory at a time. A run that cannot be summarized is skipped
        // rather than failing the upgrade; it stays in the runs store untouched.
        const cursor = r.transaction!.objectStore(RUNS).openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          try {
            const run = c.value as Run;
            if (run && typeof run.id === "string")
              summaries.put(summarize(run));
          } catch {
            /* leave this run for loadRuns() */
          }
          c.continue();
        };
      }
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => db.close(); // let a newer tab upgrade instead of blocking it
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () =>
      reject(new Error("Local storage is blocked by another tab."));
  });
}

/** Run `work` in one transaction and resolve with its result once the transaction commits. */
async function inTx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (t: IDBTransaction) => IDBRequest<T> | void,
  fallback?: string,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const request = work(t);
    t.oncomplete = () => {
      db.close();
      resolve((request ? request.result : undefined) as T);
    };
    t.onabort = t.onerror = () => {
      db.close();
      reject(t.error || new Error(fallback ?? "Local storage failed."));
    };
  });
}

const newestFirst = <T extends { importedAt: number }>(rows: T[]): T[] =>
  rows.sort((a, b) => b.importedAt - a.importedAt);

/** Lightweight list for the sidebar: no session data is read. */
export async function loadRunList(): Promise<RunSummary[]> {
  return newestFirst(
    await inTx<RunSummary[]>([SUMMARIES], "readonly", (t) =>
      t.objectStore(SUMMARIES).getAll(),
    ),
  );
}

/** One full run, or undefined if it is not saved in this browser. */
export async function loadRun(id: string): Promise<Run | undefined> {
  return inTx<Run | undefined>([RUNS], "readonly", (t) =>
    t.objectStore(RUNS).get(id),
  );
}

/** Every full run. Prefer loadRunList() + loadRun(id): this reads every saved session into memory. */
export async function loadRuns(): Promise<Run[]> {
  return newestFirst(
    await inTx<Run[]>([RUNS], "readonly", (t) => t.objectStore(RUNS).getAll()),
  );
}

/** Saves the run and its summary together, so the list and the data cannot drift apart. */
export async function saveRun(run: Run): Promise<void> {
  await inTx<void>(
    [RUNS, SUMMARIES],
    "readwrite",
    (t) => {
      t.objectStore(RUNS).put(run);
      t.objectStore(SUMMARIES).put(summarize(run));
    },
    "Local storage is full.",
  );
}

export async function deleteRun(id: string): Promise<void> {
  await inTx<void>([RUNS, SUMMARIES, CHATS], "readwrite", (t) => {
    t.objectStore(CHATS).delete(id);
    t.objectStore(RUNS).delete(id);
    t.objectStore(SUMMARIES).delete(id);
  });
}

/** Chat text is local. Provider keys and request configuration are never stored here. */
export async function loadChat(id: string): Promise<ChatThread | undefined> {
  return inTx<ChatThread | undefined>([CHATS], "readonly", (t) =>
    t.objectStore(CHATS).get(id),
  );
}
export async function saveChat(thread: ChatThread): Promise<boolean> {
  let saved = false;
  // A late stream completion must not recreate a chat after its trajectory was removed.
  await inTx<void>([RUNS, CHATS], "readwrite", (t) => {
    const run = t.objectStore(RUNS).get(thread.id);
    run.onsuccess = () => {
      if (!run.result) return;
      const messages = thread.messages.map(
        ({ id, role, content, status, provider, model, error, context }) => ({
          id,
          role,
          content,
          status,
          provider,
          model,
          error,
          context: context
            ? {
                scope: context.scope,
                includedEvents: context.includedEvents,
                totalEvents: context.totalEvents,
                excerptedEvents: context.excerptedEvents,
                characters: context.characters,
                eventNumbers: context.eventNumbers,
                selectedEventId: context.selectedEventId,
              }
            : undefined,
        }),
      );
      t.objectStore(CHATS).put({
        id: thread.id,
        draft: thread.draft,
        messages,
      });
      saved = true;
    };
  });
  return saved;
}
