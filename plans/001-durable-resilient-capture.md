# Plan 001: Persist the recording durably to IndexedDB and make upload/commit forgiving

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c7b75e6..HEAD -- src/session.ts src/types.ts src/client.ts src/index.ts src/media.ts src/http.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: bug (reliability)
- **Planned at**: commit `c7b75e6`, 2026-07-11

## Why this matters

`Session` buffers audio chunks in an in-memory `Map` and **deletes** each chunk
the moment the server acks it (`markUploaded`). A tab reload, a browser crash, or
a hard upload/commit failure therefore destroys every un-acked chunk — and for a
clinical scribe running on a flaky hospital network, silently losing the
recording is the worst possible failure. This plan makes the **local recording
the source of truth**: every captured chunk is written to IndexedDB as it is
produced, stays playable at any time, and is retryable, so nothing is discarded
until the server acks the commit. On a terminal upload/commit failure the session
enters a new, distinct `interrupted` state (kept separate from `failed`, which
means server-side processing failed) with the audio intact and a `retry()`
surface to re-send the gaps and commit.

## Current state

The files this plan touches, each with its role:

- `src/session.ts` — the concrete browser `Session`; owns capture, buffered/
  resumable upload, commit, and result polling. Contains the in-memory buffer
  and the delete-on-ack behaviour this plan replaces.
- `src/media.ts` — `RecorderController` capture abstraction with a
  `setRecorderFactory` / `getRecorderFactory` / `resetRecorderFactory` injection
  pattern. **This is the exact injection pattern to mirror for the store.**
- `src/types.ts` — the public, framework-agnostic types shared by all three
  entry points (`.`, `./server`, `./react`): `ScribeStatus`, `ScribeSession`,
  `ScribeClientConfig`.
- `src/client.ts` — `createScribeClient` wires a `SessionHttp` and constructs a
  `Session`.
- `src/index.ts` — the browser (`.`) entry point; controls the public exports.
- `src/http.ts` — `SessionHttp` (authed fetch, token refresh, per-request
  timeout) and `sleep`.

### The in-memory buffer and delete-on-ack (the bug)

`src/session.ts:51-60` — chunks live only in memory:

```ts
// Upload bookkeeping. Chunks are buffered so a resume can re-send only the
// seqs the server has not acknowledged. Once a chunk is durably uploaded
// (acked by a successful POST or confirmed via audio/status) its Blob is
// dropped from `buffer`, so only the unacknowledged tail is held in memory.
private readonly buffer = new Map<number, Blob>();
private readonly uploaded = new Set<number>();
private queue: number[] = [];
private nextSeq = 0;
private finalSeq: number | undefined;
private drainPromise: Promise<void> | null = null;
```

`src/session.ts:208-217` — `enqueue` writes only to the in-memory buffer:

```ts
private enqueue(blob: Blob): void {
  if (this.canceled) return;
  const seq = this.nextSeq++;
  this.buffer.set(seq, blob);
  if (this.stopping) this.finalSeq = seq;
  this.queue.push(seq);
  // Live uploads: swallow transient errors here; they are retried by the
  // reconcile()+flush() at stop(), which surfaces failures to the caller.
  void this.drain().catch(() => undefined);
}
```

`src/session.ts:284-292` — `markUploaded` **deletes the Blob** on ack:

```ts
/**
 * Record a seq as durably uploaded and release its buffered Blob. Only the
 * unacknowledged tail is retained, bounding memory for long recordings while
 * keeping resume correct (reconcile re-queues only what's still buffered).
 */
private markUploaded(seq: number): void {
  this.uploaded.add(seq);
  this.buffer.delete(seq);
}
```

`src/session.ts:268-282` — `runDrain` calls `markUploaded` on a successful
upload; on failure it re-queues and rethrows:

```ts
private async runDrain(): Promise<void> {
  while (this.queue.length > 0) {
    const seq = this.queue.shift() as number;
    if (this.uploaded.has(seq)) continue;
    const blob = this.buffer.get(seq);
    if (blob === undefined) continue;
    try {
      await this.uploadChunk(seq, blob, this.finalSeq === seq);
      this.markUploaded(seq);
    } catch (err) {
      this.queue.unshift(seq); // leave it pending for a later retry
      throw err;
    }
  }
}
```

`src/session.ts:294-309` — `uploadChunk` (note: hardcodes `.webm` filename — see
Maintenance notes):

```ts
private async uploadChunk(
  seq: number,
  blob: Blob,
  final: boolean,
): Promise<void> {
  const form = new FormData();
  form.append("seq", String(seq));
  form.append("chunk", blob, `chunk-${seq}.webm`);
  if (final) form.append("final", "true");

  const res = await this.http.request(
    `scribe_sessions/${this.id}/audio/chunks`,
    { method: "POST", body: form },
  );
  if (!res.ok) throw await errorFromResponse(res, `chunk ${seq} upload`);
}
```

`src/session.ts:162-187` — `runStop` finalizes, reconciles, then commits.
**`store.clear()` must be called here, only after the commit is `ok`:**

```ts
private async runStop(): Promise<void> {
  this.stopping = true;

  if (this.controller) {
    // Flushes the final chunk (marked via enqueue while `stopping`) and
    // releases the mic.
    await this.controller.stop();
    this.controller = undefined;
  }

  // Fallback: if the recorder emitted no trailing chunk, mark the highest
  // produced seq as final so audio/status can report completeness.
  if (this.finalSeq === undefined && this.nextSeq > 0) {
    this.finalSeq = this.nextSeq - 1;
  }

  // Re-send anything the server is still missing (incl. the final chunk).
  await this.reconcile();

  const res = await this.http.request(`scribe_sessions/${this.id}/commit`, {
    method: "POST",
  });
  if (!res.ok) throw await errorFromResponse(res, "commit");

  this.setStatus("processing");
}
```

`src/session.ts:220-250` — `reconcile` consults `audio/status`, marks received
seqs, re-queues buffered-but-unacked chunks, and flushes. The resume helper in
Step 5 reuses this gap logic; keep its contract intact:

```ts
private async reconcile(): Promise<void> {
  let received: number[] = [];
  try {
    const res = await this.http.request(
      `scribe_sessions/${this.id}/audio/status`,
      { method: "GET" },
    );
    if (res.ok) {
      const body = (await res.json()) as AudioStatusBody;
      received = Array.isArray(body.received_seqs) ? body.received_seqs : [];
    }
  } catch {
    // A fresh session may 404/blank here; treat as "nothing received yet".
  }

  for (const seq of received) this.markUploaded(seq);
  // ... continues numbering, re-queues unacked buffered seqs, sorts, flush()
}
```

### The injection pattern to mirror (media.ts)

`src/media.ts:89-106` — copy this shape **exactly** for the store, so jsdom tests
inject an in-memory implementation with no `fake-indexeddb`:

```ts
let activeRecorderFactory: RecorderFactory = defaultRecorderFactory;

/**
 * Override the recorder factory (used by tests to inject a fake, since jsdom
 * has no MediaRecorder). Not part of the public entry-point exports.
 */
export function setRecorderFactory(factory: RecorderFactory): void {
  activeRecorderFactory = factory;
}

/** Reset the recorder factory back to the default browser implementation. */
export function resetRecorderFactory(): void {
  activeRecorderFactory = defaultRecorderFactory;
}

export function getRecorderFactory(): RecorderFactory {
  return activeRecorderFactory;
}
```

Tests already exercise this via `installMockRecorder()` in `test/mocks.ts:90-129`,
which calls `setRecorderFactory(factory)`. Mirror that for the store.

### The public status type and session interface to extend

`src/types.ts:84-91` — `ScribeStatus` (add `"interrupted"`):

```ts
/** The lifecycle status of a browser session. */
export type ScribeStatus =
  | "idle"
  | "recording"
  | "paused"
  | "processing"
  | "completed"
  | "failed";
```

`src/types.ts:122-140` — `ScribeSession` (add `localRecording()` and `retry()`):

```ts
export interface ScribeSession {
  readonly id: string;
  /** Start mic capture and stream chunks. Resumes if the session already has chunks. */
  record(opts?: RecordOptions): Promise<void>;
  // ... pause / resume / stop / cancel / result ...
  /** Subscribe to partial transcript updates. Returns an unsubscribe function. */
  onPartialTranscript(cb: (text: string) => void): () => void;
  /** Subscribe to status changes. Returns an unsubscribe function. */
  onStatusChange(cb: (s: ScribeStatus) => void): () => void;
}
```

`src/types.ts:97-108` — `ScribeClientConfig` (add the optional store hook):

```ts
export interface ScribeClientConfig {
  /** The v2 API root, e.g. `https://api.example.com/api/v2`. */
  baseUrl: string;
  getToken: (sessionId: string) => string | Promise<string>;
  /** Optional `fetch` implementation (defaults to the global `fetch`). */
  fetch?: typeof fetch;
}
```

### Coupling facts you need (verified during recon — do not re-derive)

- **No exhaustive `switch` on `ScribeStatus` exists.** The only `switch` in
  `src/` is on `output.type` at `src/mapping.ts:43`. Adding `"interrupted"` will
  not break any exhaustive switch. (`grep -rn "switch" src/*.ts` → one hit,
  `mapping.ts:43`.)
- `src/react.ts` consumes `ScribeStatus` only via equality checks
  (`status === "recording"` at `:103`, `status === "paused"` at `:104`,
  `status !== "recording"` at `:52`) — **not** an exhaustive switch — so a new
  status value is additive and safe there.
- `src/session.ts:353-354` sets terminal statuses from result polling
  (`this.setStatus(mapped.status === "failed" ? "failed" : "completed")`). This
  is the *processing* terminal path and is unrelated to `interrupted` (which is
  the *transport* terminal path). Do not conflate them.

### Repo conventions to match

- Injection singletons live in the module that owns the abstraction and are
  **not** re-exported from `src/index.ts` (see `setRecorderFactory` — imported by
  tests directly from `../src/media`, never from the public entry point). Do the
  same for `setChunkStore`/`resetChunkStore`.
- Tests use Vitest with jsdom, a recording `fetch` mock (`createFetchMock` in
  `test/mocks.ts:34-63`), and drive capture through `installMockRecorder`
  (`test/mocks.ts:90-129`). New tests live in `test/*.test.ts` and import from
  `../src/index` for public surface and from `../src/<module>` for injection
  helpers.
- Blobs in tests are made with `audioBlob(label)` (`test/mocks.ts:132-134`):
  `new Blob([label], { type: "audio/webm" })`.

## Commands you will need

| Purpose   | Command            | Expected on success        |
|-----------|--------------------|----------------------------|
| Install   | `npm install`      | exit 0                     |
| Add dev dep | `npm install -D fake-indexeddb@^6` | exit 0; devDependency added (for Step 8 case (g)) |
| Tests     | `npm test`         | exit 0, all pass (Vitest)  |
| Single test file | `npm test -- test/persistence.test.ts` | that file passes |
| Typecheck | `npm run typecheck`| exit 0, no errors          |
| Build     | `npm run build`    | exit 0 (tsup emits `dist`) |

(Exact scripts from `package.json`: `"test": "vitest run"`,
`"typecheck": "tsc --noEmit"`, `"build": "tsup"`. There is **no** lint script —
do not invent one; `typecheck` is the static gate.)

## Scope

**In scope** (the only files you should modify or create):
- `src/persistence.ts` (create) — `ChunkStore` interface + IndexedDB default +
  in-memory implementation + `setChunkStore`/`getChunkStore`/`resetChunkStore`.
- `src/session.ts` — persist on capture, ack-not-delete, resilient upload,
  `retry()`, `localRecording()`, `interrupted` state, clear-on-commit.
- `src/types.ts` — `ScribeStatus` + `ScribeSession` additions.
- `src/client.ts` — resolve/wire the store; add the resume helper.
- `src/index.ts` — export the resume helper and any new public types.
- `test/persistence.test.ts` (create) — store + durability tests.
- `test/mocks.ts` — add an in-memory-store install helper if convenient (mirror
  `installMockRecorder`). Editing this shared helper file is allowed.
- `package.json` — add `"fake-indexeddb": "^6"` to `devDependencies` (for the
  Step 8 case (g) real-store test). Editing only the `devDependencies` block is
  in scope; do not touch scripts or runtime `dependencies`.

**Out of scope** (do NOT touch, even though they look related):
- `src/media.ts` — the recorder/capture abstraction. Dual-capture is SDK plan
  002; this plan changes only *where captured chunks are stored*, not capture.
- `src/mapping.ts` and result/transcript polling — the processing/result path is
  unchanged here.
- `src/server.ts` and `src/react.ts` — do not change their behaviour. `react.ts`
  will automatically see the new status via `onStatusChange`; that is fine and
  requires no edit. If either *must* change to compile, that is a STOP condition
  (see below).
- The backend / wire contract (`audio/chunks`, `audio/status`, `commit`) — the
  server API is fixed.

## Git workflow

- Branch: `advisor/001-durable-resilient-capture` (branch off the current HEAD;
  do not commit directly to the default branch).
- Commit per step or per logical unit. Match the repo's observed style — recent
  subjects are imperative and capitalized, e.g. `Add native chunked and
  resumable audio upload`, `Add scoped session tokens for browser scribe
  clients`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the injectable `ChunkStore` (new `src/persistence.ts`)

Create `src/persistence.ts` exporting the interface and both implementations,
plus the injection singletons mirroring `media.ts:89-106` exactly.

Interface (target shape):

```ts
export interface StoredChunk {
  seq: number;
  blob: Blob;
  /** Persisted put() meta, e.g. `{ final: true }` for the last chunk (R2). */
  meta?: Record<string, unknown>;
}

export interface ChunkStore {
  put(sessionId: string, seq: number, blob: Blob, meta?: Record<string, unknown>): Promise<void>;
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
```

Provide:

1. `class MemoryChunkStore implements ChunkStore` — backing `Map<string,
   Map<number, { blob: Blob; acked: boolean }>>`. `getPending` returns entries
   where `acked === false`; `getAll` returns all; both sorted ascending by seq.
   `listUnfinished` returns session ids whose inner map is non-empty. This is the
   store tests inject.
2. `class IndexedDbChunkStore implements ChunkStore` — default browser
   implementation. One object store keyed by `[sessionId, seq]` with an `acked`
   boolean, the `blob`, and a `meta` blob. IndexedDB stores `Blob` natively, so
   no serialization. **Inline this concrete implementation (do NOT ship it as
   prose)** — it is exercised by a real `fake-indexeddb`-backed test (Step 8):

```ts
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
          const os = db.createObjectStore(STORE, { keyPath: ["sessionId", "seq"] });
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
    const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
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
    const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
    await reqToPromise(os.delete(range));
  }
}
```
3. Injection singletons, **exact mirror** of `src/media.ts:89-106`:

```ts
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
```

**SSR / no-IDB guard is load-bearing**: if `globalThis.indexedDB` is `undefined`
(Node/SSR, or a privacy mode that blocks it), fall back to `MemoryChunkStore` and
continue — never throw at import.

**Verify**: `npm run typecheck` → exit 0. Then add a throwaway assertion in the
Step 8 test (or a quick node REPL is not available here) — for now:
`npm test` → still green (no tests reference the new file yet, so this only
confirms the module compiles and does not break the build).

### Step 2: Persist on capture, before upload (`enqueue`)

In `src/session.ts`, resolve the store once in the constructor
(`this.store = getChunkStore()`) — import `getChunkStore` from `./persistence`.
In `enqueue` (`:208-217`), write to the store **first**, before the in-memory
buffer is used for upload. Persistence must not be blocked by upload:

```ts
private enqueue(blob: Blob): void {
  if (this.canceled) return;
  const seq = this.nextSeq++;
  const isFinal = this.stopping;
  if (isFinal) this.finalSeq = seq;
  // Source of truth: persist before anything else. Swallow store errors so a
  // storage hiccup never drops capture; the in-memory buffer still lets the
  // live upload proceed. Persist final-ness in the store meta so it survives a
  // reload/retry (R2): the resumed session must know which seq is the final one.
  this.trackPut(this.store.put(this.id, seq, blob, isFinal ? { final: true } : undefined));
  this.buffer.set(seq, blob);
  this.queue.push(seq);
  void this.drain().catch(() => undefined);
}
```

The in-memory `buffer` stays as a fast cache for the live drain; IndexedDB is the
durable source of truth for resume and playback. **The `{ final: true }` meta wires
the previously-dead `ChunkStore.put` meta param (R2/R6):** it records final-ness
durably so `hydrate()` (Step 5) can restore `finalSeq` after a reload, and so a
resumed re-send still POSTs the final chunk with `final=true`.

`trackPut(...)` records the outstanding put promise so `clear()` can await it (R4,
see Step 7); it wraps the promise, swallows errors, and removes it from the
in-flight set when it settles. A minimal shape:

```ts
private readonly pendingPuts = new Set<Promise<void>>();

private trackPut(p: Promise<void>): void {
  const done = p.catch(() => undefined).finally(() => {
    this.pendingPuts.delete(done);
  });
  this.pendingPuts.add(done);
}
```

**Verify**: `npm run typecheck` → exit 0. The Step 8 test `(a)` will assert
`store.getAll(id)` contains the chunk after an emit — do not rely on eyeballing.

### Step 3: Ack, do not delete (`markUploaded`)

Change `markUploaded` (`:289-292`) so an ack marks the seq acked in the store and
drops the in-memory Blob, but **never removes it from IndexedDB**:

```ts
private markUploaded(seq: number): void {
  this.uploaded.add(seq);
  this.buffer.delete(seq);
  // Persisted copy is retained until commit; only mark it acked.
  void this.store.markAcked(this.id, seq).catch(() => undefined);
}
```

Only `store.clear(sessionId)` removes persisted chunks, and that runs solely
after a successful commit (Step 7). Do not add any other `clear` call site.

**Verify**: `npm run typecheck` → exit 0; `npm test -- test/browser.test.ts` →
still passes (the existing "chunk buffer pruning" test at
`test/browser.test.ts:334-368` asserts the *in-memory* `buffer` is pruned on ack;
that behaviour is unchanged — the persisted copy living on is separate state).

### Step 4: Resilient uploader (bounded retry + backoff)

Wrap the per-chunk POST with a bounded exponential backoff so a transient network
blip does not surface as a terminal failure. Add a small private helper and call
it from `uploadChunk`'s send (or wrap the whole `uploadChunk`). Reuse `sleep`
from `./http` (already importable; `sleep` is exported at `src/http.ts:38`).

**Make attempts and backoff injectable (R5)** so tests can disable real sleeps
and keep POST counts deterministic. Default to 3 attempts / 200ms base, but read
overrides from an internal options bag threaded through the constructor (not part
of the public `ScribeClientConfig` surface — an internal field like
`this.uploadAttempts` / `this.backoffBase`, defaulting to `3` / `200`). Tests set
`uploadAttempts = 1` (or inject a no-op `sleep`) to preserve the existing
one-POST-per-seq behaviour. Target shape:

```ts
// Defaults; overridable via the internal Session options for tests.
private readonly uploadAttempts: number = 3;
private readonly backoffBase: number = 200;

private async uploadChunk(seq: number, blob: Blob, final: boolean): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < this.uploadAttempts; attempt++) {
    try {
      const form = new FormData();
      form.append("seq", String(seq));
      form.append("chunk", blob, `chunk-${seq}.webm`);
      if (final) form.append("final", "true");
      const res = await this.http.request(
        `scribe_sessions/${this.id}/audio/chunks`,
        { method: "POST", body: form },
      );
      if (res.ok) return;
      lastErr = await errorFromResponse(res, `chunk ${seq} upload`);
    } catch (err) {
      lastErr = err;
    }
    // Backoff before the next attempt (skip the wait after the last attempt).
    if (attempt < this.uploadAttempts - 1) {
      await sleep(this.backoffBase * 2 ** attempt);
    }
  }
  throw lastErr;
}
```

On terminal failure of a live upload OR of commit, do NOT throw the recording
away — transition to `interrupted` and leave everything in IndexedDB.

**Canonical `runStop` shape (R6) — this is the ONE place `runStop`'s final body
is specified.** Steps 6 and 7 do NOT re-mutate `runStop`: the `interrupted`
status is `ScribeStatus`-only (Step 6a adds the value; the set happens here), and
the clear is fully encapsulated by `clearStore()` (Step 7). Replace the
`reconcile → commit → setStatus("processing")` tail of `runStop` (Current state
`:167-176`) with exactly this — keeping the mic-stop and the `finalSeq` fallback
(`:151-165`) above it unchanged:

```ts
// ... controller.stop() and the finalSeq fallback from Current state :151-165 ...
try {
  await this.reconcile();
  const res = await this.http.request(`scribe_sessions/${this.id}/commit`, {
    method: "POST",
  });
  if (!res.ok) throw await errorFromResponse(res, "commit");
} catch (err) {
  this.setStatus("interrupted");
  throw err;
}
await this.clearStore(); // Step 7: guarded by retainLocalRecording + awaits in-flight puts (R4)
this.setStatus("processing");
```

Keep `stop()`'s existing re-entrancy guard (`:142-160`) intact. Note `stop()`
throws for any non-`recording`/`paused` status (`:148-150`) — that is why the
post-resume path is `retry()`, not `stop()` (R1).

**Existing-test impact (R5) — read before running.** The bounded retry changes
behaviour for two existing `browser.test.ts` tests that assert POST counts and
run against a failing/500 `fetch` mock:

- `test/browser.test.ts:103-153` ("re-sends only the missing seqs"): any seq whose
  first POST fails now triggers up to `uploadAttempts` POSTs (3 by default) with
  real `200ms`/`400ms` sleeps between them — inflating both the expected POST
  count and the test latency versus the old single-attempt behaviour.
- `test/browser.test.ts:334-368` ("chunk buffer pruning"): same POST-count and
  latency inflation on any transient-failure path it exercises.

Choose ONE mitigation and apply it consistently so these two tests stay
deterministic and fast:
  1. **Preferred**: construct the `Session` under test with `uploadAttempts = 1`
     (the injectable from this step), preserving one-POST-per-seq and zero sleeps;
     OR
  2. wrap the affected assertions in `vi.useFakeTimers()` and advance timers past
     the backoff, and update the expected POST counts to account for retries.

If neither is applied, update these two tests' expected POST counts explicitly and
accept the added latency — do not leave them asserting the pre-retry counts.

**Verify**: `npm run typecheck` → exit 0; `npm test -- test/browser.test.ts` →
the existing "re-sends only the missing seqs" test (`:103-153`), the "stop" test
(`:156-183`), and the "chunk buffer pruning" test (`:334-368`) still pass **after
the R5 mitigation above**. The Step 8 test `(b)` will assert `interrupted` on a
hard failure.

### Step 5: Resume after reload (client-level helper)

> **R6 — two different `resume`s; pin which one each edit touches.** There is an
> existing `ScribeSession.resume(): void` (`src/types.ts:129`) — the
> pause/resume-recording control on the *session* object, returning `void`. This
> step adds a **new, different** `ScribeClient.resume(sessionId): Promise<ScribeSession>`
> on the *client* (`src/types.ts:142-145`), which rebuilds a session from the
> store. They share a name but live on different interfaces and have different
> signatures. When a step says "add `resume`":
> - **Step 5** edits the **`ScribeClient`** interface (`:142-145`) and the object
>   `createScribeClient` returns — the async, session-rebuilding one. Do NOT touch
>   the existing `ScribeSession.resume(): void`.
> - The existing `ScribeSession.resume(): void` is unchanged by this plan.

Add a client-level helper that lists unfinished sessions and rebuilds a `Session`
that re-hydrates its pending seqs from the store, then re-uses the existing
`reconcile()` gap logic to re-send only what the server is missing and commit.

In `src/client.ts`, after `createScribeClient`, export:

```ts
import { getChunkStore } from "./persistence";
// ...
/** Session ids that have un-committed audio persisted locally (e.g. after a reload). */
export async function listUnfinishedSessions(): Promise<string[]> {
  return getChunkStore().listUnfinished();
}
```

Give `Session` a `hydrate()` method that seeds `buffer`/`nextSeq` from
`store.getPending(id)` so a freshly constructed `Session` (over the same store)
knows which seqs are pending before `record()`/`stop()` runs `reconcile()`:

```ts
/** Re-load pending (un-acked) chunks from the store into the in-memory buffer. */
async hydrate(): Promise<void> {
  const pending = await this.store.getPending(this.id);
  for (const { seq, blob, meta } of pending) {
    this.buffer.set(seq, blob);
    if (seq + 1 > this.nextSeq) this.nextSeq = seq + 1;
    if (!this.queue.includes(seq)) this.queue.push(seq);
    // R2: restore final-ness from the persisted meta so the resumed re-send
    // still POSTs the final chunk with final=true.
    if (meta?.final === true) this.finalSeq = seq;
  }
  this.queue.sort((a, b) => a - b);
}
```

Note `getPending` may not return the final chunk if it was already acked before
the interruption; `retry()` therefore also re-derives the `nextSeq - 1` fallback
(R2, see Step 6c) so `finalSeq` is never left undefined when chunks exist.

Then expose a resume path on the client so a caller can, given a `sessionId`,
rebuild the session and flush+commit. Add to the `ScribeClient` returned object:

```ts
async resume(sessionId: string): Promise<ScribeSession> {
  const session = this.session(sessionId) as Session;
  await session.hydrate();
  return session;
}
```

(`resume` returns the hydrated session; the caller then invokes **`retry()`** from
Step 6 to reconcile + commit. **`retry()` is the SOLE post-resume commit path** —
do NOT advertise `stop()` here. A resumed `Session` is status `"idle"`, and
`stop()` throws for any non-`recording`/`paused` status (`src/session.ts:148-150`),
so `stop()` on a resumed session would throw. `retry()` runs
`reconcile()` + `flush()` + `commit()` and is safe from `idle`. Reconcile already
re-queues buffered unacked seqs — `src/session.ts:242-247` — so hydration +
reconcile re-send only the gaps.) Add
`resume(sessionId: string): Promise<ScribeSession>` to the **`ScribeClient`**
interface in `src/types.ts:142-145` (distinct from the existing
`ScribeSession.resume(): void` — see the R6 clarity callout at the top of this
step).

**Verify**: `npm run typecheck` → exit 0. Step 8 test `(d)` asserts a new
`Session` over the same store re-hydrates pending seqs and `retry()` commits.

### Step 6: Playable + retry surface + `interrupted` state

**6a — Extend `ScribeStatus`** in `src/types.ts:84-91`:

```ts
export type ScribeStatus =
  | "idle"
  | "recording"
  | "paused"
  | "processing"
  | "interrupted" // upload/commit could not reach/complete the server
  | "completed"
  | "failed";
```

**6b — Extend `ScribeSession`** in `src/types.ts:122-140` with two members:

```ts
  /**
   * The local recording as one continuous Blob (all stored chunks concatenated
   * in seq order) plus an object URL, or undefined if nothing is stored.
   */
  localRecording(): Promise<{ url: string; blob: Blob } | undefined>;
  /** Re-send any pending chunks and commit. Use after an `interrupted` status. */
  retry(): Promise<void>;
```

**6c — Implement on `Session`.** `localRecording` concatenates all stored chunks
in seq order into one Blob (valid because the storage is one continuous recording
— design choice A) and URL-creates it:

```ts
async localRecording(): Promise<{ url: string; blob: Blob } | undefined> {
  const chunks = await this.store.getAll(this.id);
  if (chunks.length === 0) return undefined;
  const ordered = chunks.slice().sort((a, b) => a.seq - b.seq).map((c) => c.blob);
  const type = ordered[0]?.type || "audio/webm";
  const blob = new Blob(ordered, { type });
  return { url: URL.createObjectURL(blob), blob };
}

async retry(): Promise<void> {
  await this.hydrate();
  // R2: re-derive the final-seq fallback before reconcile, exactly as runStop
  // does (src/session.ts:163-165 in Current state) — hydrate restores finalSeq
  // from persisted meta, but if the final chunk was acked pre-interruption this
  // guarantees the highest produced seq is still reported as final.
  if (this.finalSeq === undefined && this.nextSeq > 0) {
    this.finalSeq = this.nextSeq - 1;
  }
  await this.reconcile();
  await this.flush();
  const res = await this.http.request(`scribe_sessions/${this.id}/commit`, {
    method: "POST",
  });
  if (!res.ok) {
    this.setStatus("interrupted");
    throw await errorFromResponse(res, "commit");
  }
  await this.clearStore(); // guarded + awaits in-flight puts, R4
  this.setStatus("processing");
}
```

`retry()` is callable from `interrupted` (and after a reload via
`client.resume()` → `retry()`). Ensure the `record()` guards at
`src/session.ts:106-112` do not accidentally block a retry — `retry()` does not
call `record()`, so no change is needed there, but confirm it.

**Verify**: `npm run typecheck` → exit 0 (the new status must not break
`react.ts`, which uses only equality checks — see Current state). Step 8 tests
`(c)`, `(e)` cover `retry()` and `localRecording()`.

### Step 7: Cleanup on commit ack

`store.clear(this.id)` must run **only** after a successful commit `ok` — i.e.
exactly at the two success points you added in Steps 4 and 6c (`runStop` after
commit is ok, and `retry` after commit is ok). Provide a configurable retention
hook but default to clear-on-commit: add an optional field to
`ScribeClientConfig` in `src/types.ts:97-108`:

```ts
  /** Keep the local recording in the store after a successful commit (default false). */
  retainLocalRecording?: boolean;
```

Thread it into the `Session` constructor (via `client.ts`). Do NOT re-edit
`runStop` or `retry` here — they already call `clearStore()` (Step 4 canonical
shape, Step 6c). The `retainLocalRecording` gate lives INSIDE `clearStore()`
(below), so it applies to all three sites at once. Do not add `clear` anywhere
else. In particular, `cancel()` (`:189-202`) — decide
and document: by default `cancel()` should also `clear` the store (the user
abandoned the recording), unless `retainLocalRecording` is set. Add the guarded
clear to `cancel()`.

**Ordering guarantee (R4) — settle in-flight puts before any clear.** `enqueue`
persists fire-and-forget via `trackPut(store.put(...))` (Step 2), but `cancel()`
and the commit-success paths `await store.clear(...)`. A `put` that resolves
**after** `clear` would re-insert a record and leave a ghost session that
`listUnfinished()` reports forever. So every `clear` site must first await all
outstanding puts. Route all three clear sites through one helper:

```ts
private async clearStore(): Promise<void> {
  if (this.retainLocalRecording) return;
  // Wait for every in-flight enqueue put to settle so none lands after clear()
  // and resurrects a ghost session (R4). trackPut removes each on settle.
  await Promise.allSettled([...this.pendingPuts]);
  await this.store.clear(this.id);
}
```

Call `await this.clearStore()` at the two post-commit-ok success points (runStop,
retry) and in `cancel()`. Because `cancel()` sets `this.canceled = true` first,
`enqueue` early-returns and enqueues no new puts, so the awaited set is final —
document this invariant next to `clearStore`.

**Verify**: `npm run typecheck` → exit 0; Step 8 test `(f)` asserts the store is
non-empty right up to a successful commit and empty only after.

### Step 8: Tests (new `test/persistence.test.ts`)

Write Vitest tests using an injected `MemoryChunkStore` (`setChunkStore(...)` in a
`beforeEach`, `resetChunkStore()` in `afterEach`), the existing `createFetchMock`
/ `installMockRecorder` / `audioBlob` helpers from `test/mocks.ts`, and the public
client from `../src/index`.

**Keep these tests fast (R5):** the failure-path cases (b)/(c) hit the bounded
retry with real `200ms`/`400ms` sleeps. Either construct the session with
`uploadAttempts = 1` or wrap the failure assertions in `vi.useFakeTimers()` and
advance past the backoff, so the new persistence tests do not add real sleeps to
the suite.

Cover exactly these cases:

- **(a) persist-before-ack**: after `record()` + `recorder.emit(audioBlob("a"))`,
  `await store.getAll("sess")` contains seq 0 *before* any ack is asserted.
- **(b) failure keeps chunks + `interrupted`**: fetch mock returns 500 for
  `/audio/chunks` and `/commit`; after `stop()` rejects, `store.getPending` still
  holds the chunk (not lost) and `session.status === "interrupted"`.
- **(c) `retry()` re-sends pending + commits**: flip the mock to succeed, call
  `session.retry()`, assert `/commit` fired and status is `processing`.
- **(d) simulated reload**: build a *second* `Session` (via
  `client.resume("sess")`) over the **same** injected store; assert it
  re-hydrates the pending seqs and that **`retry()`** (NOT `stop()` — a resumed
  session is `idle`, and `stop()` throws for non-`recording`/`paused` status)
  reconciles and commits. Also assert the resumed re-send POSTs the final chunk
  with `final=true` (see R2 below) — i.e. the last `/audio/chunks` POST carries
  `form.get("final") === "true"`.
- **(e) `localRecording()` concatenation**: emit blobs `"a"`,`"b"`,`"c"`; assert
  `(await session.localRecording())!.blob` size equals the summed sizes of the
  three stored chunks (concatenation in seq order).
- **(f) clear-only-after-commit**: assert `store.listUnfinished()` includes the
  session right up to the successful commit, and excludes it afterward.
- **(g) real `IndexedDbChunkStore` (fake-indexeddb)**: exercise the REAL
  IndexedDB implementation, not `MemoryChunkStore`. Import `"fake-indexeddb/auto"`
  at the top of the test file (it installs a global `indexedDB`), construct
  `new IndexedDbChunkStore()` directly (import from `../src/persistence`), and
  assert the full surface end-to-end:
  - `put("s", 0, audioBlob("a"))`, `put("s", 1, audioBlob("b"), { final: true })`;
  - `getAll("s")` returns both, ascending by seq, and seq 1 carries
    `meta.final === true`;
  - `getPending("s")` returns both (nothing acked yet); after
    `markAcked("s", 0)`, `getPending("s")` returns only seq 1;
  - `listUnfinished()` includes `"s"` (and a second `put("s2", ...)` makes it
    include both distinct ids);
  - `clear("s")` empties `getAll("s")` and drops `"s"` from `listUnfinished()`
    while leaving `"s2"` intact.

  This is the only test that touches real IndexedDB; cases (a)–(f) keep using the
  injected `MemoryChunkStore` for speed. Add `"fake-indexeddb": "^6"` to
  `devDependencies` in `package.json` (`npm install` to lock it) — the repo uses
  Vitest, and `fake-indexeddb/auto` works under jsdom.

Structural pattern: model the fetch mock and drive loop after
`test/browser.test.ts:103-153` (mid-recording drop → reconcile → commit) and the
store-injection after `installMockRecorder` in `test/mocks.ts:90-129`.

**Verify**: `npm test -- test/persistence.test.ts` → all new tests pass; then
`npm test` → the whole suite (`test/browser.test.ts`, `test/react.test.tsx`,
`test/server.test.ts`) is green.

## Test plan

- New file `test/persistence.test.ts` covering cases (a)–(g) above. Cases (a)–(f)
  use the injected `MemoryChunkStore`; case (g) exercises the REAL
  `IndexedDbChunkStore` via `fake-indexeddb/auto` (imported at the top of the
  file), so the production store has direct coverage of
  put/markAcked/getPending/getAll/listUnfinished/clear.
- `package.json` gains `"fake-indexeddb": "^6"` in `devDependencies`.
- Optionally extend `test/mocks.ts` with an `installMemoryChunkStore()` helper
  mirroring `installMockRecorder` (returns a handle exposing the underlying
  `MemoryChunkStore` so a test can assert `getAll`/`getPending`/`listUnfinished`).
- Existing tests must still pass unchanged, in particular:
  - `test/browser.test.ts:334-368` (in-memory buffer pruning) — the in-memory
    prune behaviour is preserved; only the *persisted* copy now survives.
  - `test/browser.test.ts:156-183` (stop → commit → processing).
- Verification: `npm test` → all pass, including the 6 new cases.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0; `test/persistence.test.ts` exists and its cases (a)–(g) pass (case (g) exercises the real `IndexedDbChunkStore` via `fake-indexeddb`)
- [ ] `npm run build` exits 0 (tsup emits `dist/`)
- [ ] `package.json` `devDependencies` includes `fake-indexeddb` (`grep -n "fake-indexeddb" package.json`)
- [ ] `src/persistence.ts` exists and exports `ChunkStore`, a named `IndexedDbChunkStore` (importable by the test), a `MemoryChunkStore`, and `setChunkStore`/`getChunkStore`/`resetChunkStore` (`grep -n "export" src/persistence.ts` shows all of them)
- [ ] `grep -n "store.clear" src/session.ts` shows `store.clear` called from exactly ONE site — the `clearStore()` helper — and `grep -n "clearStore" src/session.ts` shows it invoked ONLY on the post-commit-ack success paths (runStop after commit ok, retry after commit ok) and cancel — never before a commit ack; `clearStore` awaits in-flight puts before clearing (R4)
- [ ] `grep -n "interrupted" src/types.ts src/session.ts` shows the new status added to `ScribeStatus` and set on terminal upload/commit failure
- [ ] `grep -n "localRecording\|retry" src/types.ts` shows both new members on `ScribeSession`
- [ ] `grep -n "listUnfinishedSessions\|resume" src/index.ts src/client.ts` shows the resume surface is exported/wired
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts
  (drift since `c7b75e6`).
- The `ScribeSession` public interface cannot be extended without changing
  `./react` (`src/react.ts`) or `./server` (`src/server.ts`) behaviour — report
  the exact coupling. (Recon says it is additive and safe: `react.ts` uses only
  equality checks and there is no exhaustive `ScribeStatus` switch anywhere — if
  reality differs, that is the coupling to report.)
- Adding `"interrupted"` to `ScribeStatus` breaks an exhaustive `switch`
  somewhere `typecheck` flags (recon found none in `src/`) — fix the offending
  switch in-scope if it is one of the in-scope files, otherwise report it.
- IndexedDB Blob storage is unavailable in the target AND the in-memory fallback
  is judged unacceptable for the use case (surface the question rather than
  shipping a store that silently loses data on reload).
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file (`src/media.ts`,
  `src/mapping.ts`, backend wire contract).

## Maintenance notes

For the human/agent who owns this after the change lands:

- **SDK plan 002 (dual-capture segments) builds on this session and store.** Keep
  the store as the source of truth; 002 will add a second captured stream and
  must persist through the same `ChunkStore`.
- A reviewer must confirm **nothing deletes IndexedDB data before a commit ack** —
  `store.clear` has a single call site (the `clearStore()` helper), invoked only
  from the two post-commit-ok paths and the explicit `cancel()`, all gated by
  `retainLocalRecording`, and `clearStore()` awaits in-flight `put`s first so no
  late write resurrects a ghost session (R4).
- A reviewer should confirm `localRecording()`'s naive Blob concatenation is
  valid for the continuous-recording format on **both Chrome (webm) and Safari
  (mp4)** — a single MediaRecorder session produces one continuous file whose
  timeslice chunks concatenate byte-for-byte, so this holds; call it out in the
  PR so it is consciously accepted.
- **Latent cross-browser bug to fix in a small follow-up (NOT required by this
  plan):** `uploadChunk` hardcodes the filename `chunk-${seq}.webm`
  (`src/session.ts:301`, preserved in Step 4's shape) while Safari's
  `MediaRecorder` records `mp4`/`audio/mp4`. The filename/MIME are cosmetic for
  the current backend but should be derived from the blob's actual `type` — flag
  it; fixing filename+mime is a small independent change.
- **Underspecified detail, smallest reasonable choice made:** `cancel()` is made
  to `clear` the store by default (the user abandoned the recording) unless
  `retainLocalRecording` is set. If product wants abandoned recordings kept for
  recovery, flip that default and document it — noted here rather than guessed
  silently.
- The retry backoff defaults to 3 attempts / 200ms base (`this.uploadAttempts` /
  `this.backoffBase` in Step 4, overridable via the internal Session options that
  the tests use — R5). If real-world hospital networks need more patience, promote
  these to `ScribeClientConfig` rather than hard-coding.
