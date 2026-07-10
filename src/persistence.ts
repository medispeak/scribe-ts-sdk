/**
 * Durable chunk storage for the browser scribe session.
 *
 * The local recording is the source of truth: every captured chunk is written
 * here as it is produced and kept until the server acks the commit, so a tab
 * reload, browser crash, or hard upload/commit failure never destroys audio.
 *
 * Like the recorder factory in `media.ts`, the active store is an injectable
 * singleton so jsdom tests can swap in an in-memory implementation with no
 * `fake-indexeddb`. The default is an IndexedDB-backed store, with an in-memory
 * fallback when `indexedDB` is unavailable (SSR / privacy mode).
 */

export interface StoredChunk {
  seq: number;
  blob: Blob;
  /** Persisted put() meta, e.g. `{ final: true }` for the last chunk. */
  meta?: Record<string, unknown>;
}

export interface ChunkStore {
  put(
    sessionId: string,
    seq: number,
    blob: Blob,
    meta?: Record<string, unknown>,
  ): Promise<void>;
  markAcked(sessionId: string, seq: number): Promise<void>;
  /** Chunks not yet acked, ascending by seq. */
  getPending(sessionId: string): Promise<StoredChunk[]>;
  /** Every stored chunk (acked or not), ascending by seq — for playback. */
  getAll(sessionId: string): Promise<StoredChunk[]>;
  /** Session ids that still have any stored chunks (unfinished recordings). */
  listUnfinished(): Promise<string[]>;
  /** Remove all persisted chunks for a session (only after a commit ack). */
  clear(sessionId: string): Promise<void>;
}

/* --------------------------------------------------------------------------
 * In-memory store (used by tests; SSR / no-IndexedDB fallback)
 * ------------------------------------------------------------------------ */

interface MemoryEntry {
  blob: Blob;
  acked: boolean;
  meta?: Record<string, unknown>;
}

export class MemoryChunkStore implements ChunkStore {
  private readonly sessions = new Map<string, Map<number, MemoryEntry>>();

  private forSession(sessionId: string): Map<number, MemoryEntry> {
    let inner = this.sessions.get(sessionId);
    if (!inner) {
      inner = new Map<number, MemoryEntry>();
      this.sessions.set(sessionId, inner);
    }
    return inner;
  }

  async put(
    sessionId: string,
    seq: number,
    blob: Blob,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    this.forSession(sessionId).set(seq, { blob, acked: false, meta });
  }

  async markAcked(sessionId: string, seq: number): Promise<void> {
    const entry = this.sessions.get(sessionId)?.get(seq);
    if (entry) entry.acked = true;
  }

  async getPending(sessionId: string): Promise<StoredChunk[]> {
    return this.sorted(sessionId).filter((c) => c.acked === false).map(toStored);
  }

  async getAll(sessionId: string): Promise<StoredChunk[]> {
    return this.sorted(sessionId).map(toStored);
  }

  async listUnfinished(): Promise<string[]> {
    const ids: string[] = [];
    for (const [id, inner] of this.sessions) {
      if (inner.size > 0) ids.push(id);
    }
    return ids;
  }

  async clear(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  private sorted(sessionId: string): Array<MemoryEntry & { seq: number }> {
    const inner = this.sessions.get(sessionId);
    if (!inner) return [];
    return [...inner.entries()]
      .map(([seq, entry]) => ({ seq, ...entry }))
      .sort((a, b) => a.seq - b.seq);
  }
}

function toStored(entry: MemoryEntry & { seq: number }): StoredChunk {
  return { seq: entry.seq, blob: entry.blob, meta: entry.meta };
}

/* --------------------------------------------------------------------------
 * IndexedDB store (default browser implementation)
 * ------------------------------------------------------------------------ */

const DB_NAME = "scribe-chunks";
const STORE = "chunks";
const DB_VERSION = 1;

/** Promisify an IDBRequest into a Promise. */
function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface ChunkRecord {
  sessionId: string;
  seq: number;
  blob: Blob;
  acked: boolean;
  meta?: Record<string, unknown>;
}

export class IndexedDbChunkStore implements ChunkStore {
  private dbPromise: Promise<IDBDatabase> | undefined;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          // Composite key [sessionId, seq]; an index on sessionId for range scans.
          const os = db.createObjectStore(STORE, {
            keyPath: ["sessionId", "seq"],
          });
          os.createIndex("bySession", "sessionId", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.open();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  /** All records for a sessionId, ascending by seq. */
  private async recordsFor(sessionId: string): Promise<ChunkRecord[]> {
    const os = await this.tx("readonly");
    const range = IDBKeyRange.bound(
      [sessionId, -Infinity],
      [sessionId, Infinity],
    );
    const all = (await reqToPromise(os.getAll(range))) as ChunkRecord[];
    return all.sort((a, b) => a.seq - b.seq);
  }

  async put(
    sessionId: string,
    seq: number,
    blob: Blob,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const os = await this.tx("readwrite");
    const record: ChunkRecord = { sessionId, seq, blob, acked: false, meta };
    await reqToPromise(os.put(record));
  }

  async markAcked(sessionId: string, seq: number): Promise<void> {
    const os = await this.tx("readwrite");
    const existing = (await reqToPromise(os.get([sessionId, seq]))) as
      | ChunkRecord
      | undefined;
    if (!existing) return;
    existing.acked = true;
    await reqToPromise(os.put(existing));
  }

  async getPending(sessionId: string): Promise<StoredChunk[]> {
    const records = await this.recordsFor(sessionId);
    return records
      .filter((r) => !r.acked)
      .map((r) => ({ seq: r.seq, blob: r.blob, meta: r.meta }));
  }

  async getAll(sessionId: string): Promise<StoredChunk[]> {
    const records = await this.recordsFor(sessionId);
    return records.map((r) => ({ seq: r.seq, blob: r.blob, meta: r.meta }));
  }

  async listUnfinished(): Promise<string[]> {
    const os = await this.tx("readonly");
    const all = (await reqToPromise(os.getAll())) as ChunkRecord[];
    return [...new Set(all.map((r) => r.sessionId))];
  }

  async clear(sessionId: string): Promise<void> {
    const os = await this.tx("readwrite");
    const range = IDBKeyRange.bound(
      [sessionId, -Infinity],
      [sessionId, Infinity],
    );
    await reqToPromise(os.delete(range));
  }
}

/* --------------------------------------------------------------------------
 * Injectable singleton (mirrors media.ts's recorder-factory injection)
 * ------------------------------------------------------------------------ */

function defaultChunkStore(): ChunkStore {
  // SSR / no-IndexedDB guard: never throw at import or first use.
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  return idb ? new IndexedDbChunkStore() : new MemoryChunkStore();
}

let activeChunkStore: ChunkStore = defaultChunkStore();

/** Override the chunk store (tests inject MemoryChunkStore; not a public export). */
export function setChunkStore(store: ChunkStore): void {
  activeChunkStore = store;
}

/** Reset back to the environment default (IndexedDB, or in-memory fallback). */
export function resetChunkStore(): void {
  activeChunkStore = defaultChunkStore();
}

export function getChunkStore(): ChunkStore {
  return activeChunkStore;
}
