# Plan 002 (SDK): Capture standalone transcription segments and stream a live transcript during recording

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c7b75e6..HEAD -- src/media.ts src/session.ts src/types.ts src/mapping.ts src/http.ts test/mocks.ts test/browser.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: SDK plan 001 (shares `Session` internals — the continuous storage recorder + resumable chunk upload) and backend plan 022 (`scribe_sessions/:id/audio/segments` endpoint + a live transcript surfaced in `GET scribe_sessions/:id`)
- **Category**: feature
- **Planned at**: commit `c7b75e6`, 2026-07-11

## Why this matters

The continuous `MediaRecorder` used for durable storage produces one playable
file, but its streamed timeslice chunks are **not independently decodable** — you
cannot transcribe them as they arrive. To give the clinician a real-time feel, we
run a **second** capture that emits short, standalone, independently-decodable
audio files purely for transcription, upload them best-effort to a backend
segments endpoint, and poll the growing transcript while recording is still in
progress. The durable storage recording (SDK plan 001) is the safety net and
stays untouched: if a live segment is lost, the only cost is a little live
transcript, recoverable when the full recording is committed and processed. This
plan adds the segment capture, the segment upload, and the in-recording transcript
poll, all behind a flag (default off) so it can ship in lockstep with the backend
flag and be enabled once backend plan 022 is live.

## Current state

- `src/media.ts` — the mockable mic-capture abstraction and the factory-injection
  pattern this plan mirrors for segments. A `RecorderFactory` is swapped in tests
  via `setRecorderFactory`:
  ```ts
  // src/media.ts:25-27
  export type RecorderFactory = (
    params: StartRecordingParams,
  ) => Promise<RecorderController>;
  ```
  ```ts
  // src/media.ts:89-106
  let activeRecorderFactory: RecorderFactory = defaultRecorderFactory;

  export function setRecorderFactory(factory: RecorderFactory): void {
    activeRecorderFactory = factory;
  }

  export function resetRecorderFactory(): void {
    activeRecorderFactory = defaultRecorderFactory;
  }

  export function getRecorderFactory(): RecorderFactory {
    return activeRecorderFactory;
  }
  ```
  The default factory calls `getUserMedia({ audio: true })` and drives one
  `MediaRecorder` (`src/media.ts:50-72`). Segment capture must obtain its own
  file stream **without disturbing** this storage recorder.

- `src/session.ts` — `Session` owns the recording lifecycle. `record()` starts the
  storage recorder and wires `onChunk` into the resumable upload queue:
  ```ts
  // src/session.ts:106-128
  async record(opts?: RecordOptions): Promise<void> {
    if (this._status === "recording" || this._status === "paused") {
      throw new ScribeError("recording already in progress");
    }
    if (this._status === "processing") {
      throw new ScribeError("session already committed");
    }

    const chunkMs = opts?.chunkMs ?? DEFAULT_CHUNK_MS;
    this.canceled = false;
    this.stopping = false;
    this.setStatus("recording");

    // Resume: consult audio/status and re-send only the seqs the server is
    // missing; continue numbering after the highest known seq.
    await this.reconcile();

    const factory = getRecorderFactory();
    this.controller = await factory({
      chunkMs,
      onChunk: (blob) => this.enqueue(blob),
    });
  }
  ```

- `src/session.ts:162-187` — `runStop()` stops the storage recorder, reconciles the
  missing chunks, and POSTs `commit`. This path is the **durability guarantee** and
  MUST NOT be made to depend on segments:
  ```ts
  private async runStop(): Promise<void> {
    this.stopping = true;
    if (this.controller) {
      await this.controller.stop();
      this.controller = undefined;
    }
    // ... reconcile() ...
    const res = await this.http.request(`scribe_sessions/${this.id}/commit`, {
      method: "POST",
    });
    if (!res.ok) throw await errorFromResponse(res, "commit");
    this.setStatus("processing");
  }
  ```

- `src/session.ts:189-202` — `cancel()` tears the storage recorder down and returns
  to `idle`. Segment teardown must be added here too.

- `src/session.ts:294-309` — `uploadChunk` is the exact multipart-POST shape to
  mirror for segment upload (`FormData`, `http.request`, non-ok → throw):
  ```ts
  private async uploadChunk(seq: number, blob: Blob, final: boolean): Promise<void> {
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

- `src/session.ts:91-100` — the existing partial-transcript channel to reuse (no
  new public API needed):
  ```ts
  onPartialTranscript(cb: Subscriber<string>): () => void {
    this.partialSubs.add(cb);
    return () => this.partialSubs.delete(cb);
  }

  private emitPartial(text: string): void {
    if (text === this.lastPartial) return;
    this.lastPartial = text;
    for (const cb of this.partialSubs) cb(text);
  }
  ```

- `src/session.ts:315-361` — `result()` maps `GET scribe_sessions/:id` with
  `mapSessionBody` and calls `emitPartial(mapped.transcript)`. The live poll reuses
  the **same** GET + mapper, but runs *during* recording and stops when `result()`
  takes over:
  ```ts
  // src/session.ts:349-351
  const mapped = mapSessionBody(body);
  if (mapped.transcript !== undefined) this.emitPartial(mapped.transcript);
  ```

- `src/mapping.ts:127-150` — `mapSessionBody` (and `extractTranscript`,
  `src/mapping.ts:91-102`) turn the wire body into a `ScribeResult` whose
  `.transcript` is the string to emit. Reuse these verbatim; do not add a parallel
  parser.

- `src/http.ts:78-117` — `SessionHttp.request(path, init, opts)` is the authed
  fetch wrapper. It sets `Authorization` itself and derives the multipart boundary
  itself, so **callers must not set their own headers for `FormData` bodies**
  (`src/http.ts:69-72`). `getJson<T>` (`src/http.ts:120-128`) is the authed-GET
  helper the poll can use.

- `src/types.ts:110-113` — the current `RecordOptions`, which this plan extends:
  ```ts
  export interface RecordOptions {
    /** MediaRecorder timeslice in ms (default 5000). */
    chunkMs?: number;
  }
  ```

- **Test conventions** (`test/mocks.ts`, `test/browser.test.ts`): tests inject a
  fake recorder via `installMockRecorder()` (`test/mocks.ts:90-129`) and a fake
  `fetch` via `createFetchMock(handler)` (`test/mocks.ts:34-63`); assertions read
  `mock.matching(suffix, method)` and `formField(body, name)`. `audioBlob(label)`
  (`test/mocks.ts:132-134`) builds a tiny `audio/webm` blob. Existing tests use
  `vi.waitFor(...)` to await async queue drains (see
  `test/browser.test.ts:47`). Match these helpers — do **not** invent a new harness.

## Commands you will need

| Purpose             | Command                                             | Expected on success        |
|---------------------|-----------------------------------------------------|----------------------------|
| Install             | `npm install`                                       | exit 0                     |
| Typecheck           | `npm run typecheck`                                  | exit 0, no TS errors       |
| Tests (all)         | `npm test`                                           | all pass                   |
| Tests (one file)    | `npx vitest run test/segments.test.ts`              | all pass                   |
| Tests (browser)     | `npx vitest run test/browser.test.ts`               | all pass (no regressions)  |
| Build               | `npm run build`                                      | exit 0                     |

(Exact scripts verified in `package.json:59-65` — `test` = `vitest run`,
`typecheck` = `tsc --noEmit`, `build` = `tsup`. **There is no lint script in this
repo** — do not invent one.)

## Suggested executor toolkit

- No repo-specific skills are required. The only injection seams you need are the
  existing `setRecorderFactory` / `resetRecorderFactory` (`src/media.ts:95-102`)
  and `createFetchMock` (`test/mocks.ts:34`).

## Scope

**In scope** (the only files you should modify or create):
- `src/segments.ts` (**create**) — the `SegmentRecorder` factory + injection hooks,
  mirroring `src/media.ts`.
- `src/session.ts` — segment upload, the live poll loop, and `record()` / `stop()` /
  `cancel()` wiring.
- `src/types.ts` — `RecordOptions.segmentMs` and the segment opt-out option.
- `test/mocks.ts` — a fake `SegmentRecorder` installer, mirroring
  `installMockRecorder`.
- `test/segments.test.ts` (**create**) — the new tests (see Test plan).

**Out of scope** (do NOT touch, even though they look related):
- The durable storage / resumable-chunk path — `enqueue` / `reconcile` / `drain` /
  `uploadChunk` / `runStop`'s commit (`src/session.ts:208-309, 162-187`). Segments
  must be **strictly additive**; a segment failure must never reach this path.
- `result()` terminal polling and `mapSessionBody` behavior — reuse, do not change
  (`src/session.ts:315-361`, `src/mapping.ts`).
- The backend (this repo is the SDK only) and the React entry point (`src/react.ts`).

## Git workflow

- Branch: `advisor/002-live-transcription-segments` off `main`.
- Commit per step or per logical unit. Match the repo's short imperative subject
  style (see `git log --oneline`: e.g. `Fix four review findings: language_hint
  scalar, poll timeout, stop() guard, chunk pruning`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add an injectable `SegmentRecorder` in `src/segments.ts`

Create `src/segments.ts` mirroring `src/media.ts`'s factory pattern
(`src/media.ts:25-106`). A **segment** is a *complete, standalone, playable* audio
file — unlike a storage chunk. Define:

```ts
export interface StartSegmentParams {
  /** Target duration of each standalone segment, ms. */
  segmentMs: number;
  /** Called once per completed, independently-decodable segment file. */
  onSegment: (blob: Blob) => void;
}

export interface SegmentController {
  /** Stop segment capture; resolves after the final segment has been emitted. */
  stop(): Promise<void>;
}

export type SegmentRecorderFactory = (
  params: StartSegmentParams,
) => Promise<SegmentController>;
```

Add module-level injection hooks exactly like `src/media.ts:89-106`:
`activeSegmentFactory`, `setSegmentRecorderFactory`, `resetSegmentRecorderFactory`,
`getSegmentRecorderFactory`.

Default implementation: open the mic via
`navigator.mediaDevices.getUserMedia({ audio: true })` (its **own** stream — do
not share the storage recorder's `MediaRecorder`) and drive a second
`MediaRecorder` that is **stopped + restarted per segment**, because each
`stop()` flushes one complete file. Start with a **fixed ~6000 ms cadence**
(restart on a timer). Emit each completed file via `onSegment` in the
`MediaRecorder.onstop`/`ondataavailable` handler. Guard the environment exactly
like `src/media.ts:39-48` (throw `ScribeError` when `getUserMedia` or
`MediaRecorder` is absent). Silence-cut (restarting on a brief Web Audio RMS dip so
the gap lands in silence) is a **documented refinement — do NOT implement it in
this step**; note it in Maintenance notes.

**Verify**: `npm run typecheck` → exit 0 (the new module compiles and its exports
type-check).

### Step 2: Add a fake `SegmentRecorder` to `test/mocks.ts`

Mirror `installMockRecorder` (`test/mocks.ts:90-129`). Add
`installMockSegmentRecorder()` that calls `setSegmentRecorderFactory` with a fake
capturing `onSegment` + `segmentMs`, and returns a handle exposing
`emit(blob)` (drive one segment), `stopped()`, and `segmentMs()`. Keep the
`audioBlob` helper (`test/mocks.ts:132-134`) for segment blobs.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Add `Session.uploadSegment(seq, blob)` — best-effort, isolated

In `src/session.ts`, add private segment-upload state and a method mirroring
`uploadChunk` (`src/session.ts:294-309`) but posting to the **segments** endpoint
with fields `seq` + `segment`:

```ts
private nextSegmentSeq = 0;

private async uploadSegment(seq: number, blob: Blob): Promise<void> {
  const form = new FormData();
  form.append("seq", String(seq));
  form.append("segment", blob, `segment-${seq}.webm`);
  const res = await this.http.request(
    `scribe_sessions/${this.id}/audio/segments`,
    { method: "POST", body: form },
  );
  if (!res.ok) throw await errorFromResponse(res, `segment ${seq} upload`);
}
```

Wrap the *call site* so failures are **swallowed** (best-effort). Fire-and-forget
each upload: the `seq` is assigned synchronously (so segment ordering is preserved
in the seq field — test (a) relies on this), while a failed upload only drops that
one segment and never rejects into the storage path:

```ts
private enqueueSegment(blob: Blob): void {
  if (this.canceled) return;
  const seq = this.nextSegmentSeq++;
  // Best-effort: a lost segment only costs a little live transcript.
  void this.uploadSegment(seq, blob).catch(() => undefined);
}
```

Do NOT set a `Content-Type` header (the wrapper derives the multipart boundary —
`src/http.ts:69-72`). Do NOT touch `nextSeq`, `buffer`, `queue`, or `finalSeq`
(those belong to the storage path).

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Add the in-recording live-transcript poll

In `src/session.ts`, add a poll loop that runs **only while recording**, reusing
the GET + mapper from `result()` (`src/session.ts:349-351`) and the existing
`emitPartial` channel (`src/session.ts:91-100`). Store the timer/loop handle and a
running flag so it can be stopped in Step 5:

```ts
private livePollTimer: ReturnType<typeof setTimeout> | undefined;
private livePolling = false;

private startLivePoll(intervalMs: number): void {
  if (this.livePolling) return;
  this.livePolling = true;
  const tick = async () => {
    if (!this.livePolling) return;
    try {
      const body = await this.http.getJson<WireSessionBody>(
        `scribe_sessions/${this.id}`,
        "live transcript poll",
      );
      const mapped = mapSessionBody(body);
      if (mapped.transcript !== undefined) this.emitPartial(mapped.transcript);
    } catch {
      // Best-effort: swallow poll errors; result() is the authoritative poll.
    }
    if (this.livePolling) this.livePollTimer = setTimeout(tick, intervalMs);
  };
  this.livePollTimer = setTimeout(tick, intervalMs);
}

private stopLivePoll(): void {
  this.livePolling = false;
  if (this.livePollTimer !== undefined) {
    clearTimeout(this.livePollTimer);
    this.livePollTimer = undefined;
  }
}
```

Use a `~1500 ms` default interval (declare a `DEFAULT_LIVE_POLL_INTERVAL_MS`
constant next to `DEFAULT_POLL_INTERVAL_MS`, `src/session.ts:22-24`). `getJson` is a
method on `SessionHttp` reached via `this.http.getJson` (no import needed);
`mapSessionBody`/`WireSessionBody` are already imported (`src/session.ts:8-13`). Make
the interval injectable (see R1 / Step 6): thread `RecordOptions.livePollIntervalMs`
into this call so tests can pass a tiny value.

**Verify**: `npm run typecheck` → exit 0.

### Step 5: Wire segments + live poll into `record()` / `stop()` / `cancel()`

- In `record()` (`src/session.ts:106-128`), **after** the existing storage-recorder
  startup, and **only when segments are enabled** (Step 6 option), also:
  - `this.nextSegmentSeq = 0;`
  - start the segment recorder via `getSegmentRecorderFactory()({ segmentMs, onSegment: (b) => this.enqueueSegment(b) })`, storing the returned `SegmentController` on a private field (e.g. `this.segmentController`);
  - `this.startLivePoll(opts?.livePollIntervalMs ?? DEFAULT_LIVE_POLL_INTERVAL_MS);` (the injectable interval mirrors how `result()` accepts `pollIntervalMs`);
  Starting the segment recorder must be resilient: if the segment factory throws,
  catch it, leave the storage recorder running, and continue (log/swallow) — the
  storage path must not be blocked by a segment failure.
- In `runStop()` (`src/session.ts:162-187`), **before** the `commit` POST: stop the
  live poll (`this.stopLivePoll()`), then stop the segment recorder
  (`await this.segmentController?.stop()` wrapped in try/catch, then clear it). Do
  this **without** changing the storage stop/reconcile/commit sequence. A thrown
  segment `stop()` must not prevent `commit`.
- In `cancel()` (`src/session.ts:189-202`), also `this.stopLivePoll()` and
  best-effort stop + clear `this.segmentController` (mirror the existing
  best-effort `controller.stop()` there).

`result()` (`src/session.ts:315-361`) is unchanged and takes over polling after
`processing`; the live poll must already be stopped by then.

**Verify**: `npx vitest run test/browser.test.ts` → all existing browser tests
still pass (no storage-path regression).

### Step 6: Extend `RecordOptions` (segmentMs + opt-out) and thread it through

In `src/types.ts:110-113`, extend `RecordOptions`:

```ts
export interface RecordOptions {
  /** MediaRecorder timeslice in ms (default 5000). */
  chunkMs?: number;
  /** Standalone transcription-segment duration in ms (default 6000). */
  segmentMs?: number;
  /** Live-transcript poll interval in ms (default 1500). Injectable so tests
   * can pass a tiny value (mirrors `result()`'s `pollIntervalMs`). */
  livePollIntervalMs?: number;
  /**
   * Capture standalone segments + poll a live transcript during recording.
   * Defaults to `false` until backend plan 022 is confirmed live (lockstep with
   * the backend segments flag); set `true` to opt in to live capture once the
   * endpoint ships. When `false`, behavior is storage-only capture (post-commit
   * transcript only).
   */
  liveTranscription?: boolean;
}
```

In `record()`, read `const segmentMs = opts?.segmentMs ?? DEFAULT_SEGMENT_MS;`
(add `DEFAULT_SEGMENT_MS = 6000` near `src/session.ts:22-24`) and
`const live = opts?.liveTranscription ?? false;`. Only start the segment recorder +
live poll when `live` is true. When `false` (the default), behavior is identical to
today (storage recorder + post-commit `result()` only). Flip the default to `true`
once backend plan 022 is confirmed live; until then callers opt in per-call by
passing `liveTranscription: true`.

**Verify**: `npm run typecheck` → exit 0.

### Step 7: Build the package

**Verify**: `npm run build` → exit 0 (tsup emits `dist/` with the new module folded
into the existing entry points; no new public export is required since segments
reuse `onPartialTranscript`).

## Test plan

Create `test/segments.test.ts`, modeled structurally on `test/browser.test.ts`
(same imports from `../src/index` + `./mocks`, `createFetchMock`, `vi.waitFor`).
Use `installMockSegmentRecorder()` (Step 2) and `installMockRecorder()` together so
both captures run. Call `record({ liveTranscription: true, livePollIntervalMs: 1 })`
so the live poll is actually exercised (it is off by default per Step 6) and the
first poll fires well within `vi.waitFor`'s default 1000 ms timeout — mirroring how
the existing tests pass `pollIntervalMs: 1` to `result()`
(`test/browser.test.ts:218,244,266`). Cover:

- **(a) segments POST with incrementing seq**: drive the segment recorder twice;
  assert two POSTs to a URL ending `/audio/segments` via
  `mock.matching("/audio/segments", "POST")`, with `formField(body, "seq")` equal
  to `"0"` then `"1"`, each carrying a `segment` blob field, and `bearer === TOKEN`.
- **(b) a segment upload failure is swallowed and does not affect storage chunks**:
  make the fetch handler return `500` for `/audio/segments` but `200` for
  `/audio/chunks` (+ `/audio/status`). Emit a segment (fails) and a storage chunk
  (via `installMockRecorder().emit`); assert the storage chunk still POSTs
  successfully to `/audio/chunks` and that `session.record()`/the emit does **not**
  reject.
- **(c) live poll GETs during recording and emits partials**: fetch handler returns
  a growing transcript on `GET /scribe_sessions/:id` (match with the regex from
  `test/browser.test.ts:190`, `/\/scribe_sessions\/[^/]+$/` + `GET`); subscribe via
  `onPartialTranscript` and `vi.waitFor` until a partial is received during
  recording (before `stop()`).
- **(d) stop() halts the live poll and the segment recorder**: after `await
  session.stop()`, assert `segmentHandle.stopped()` is true and that no further
  `GET /scribe_sessions/:id` calls occur after stop. Snapshot the GET count using
  the regex matcher `/\/scribe_sessions\/[^/]+$/` with method `GET` (as
  `test/browser.test.ts:190` does) around a short wait — **not**
  `mock.matching("/scribe_sessions/", "GET")`, whose `endsWith` suffix never matches
  the real URL (it ends in the session id, no trailing slash) and would make the
  assertion pass trivially, unable to catch a poll that kept running after stop().

Verification: `npx vitest run test/segments.test.ts` → all pass; `npm test` → all
pass including these new tests and every existing `test/browser.test.ts` test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npx vitest run test/segments.test.ts` passes with tests covering (a) incrementing-seq segment POST, (b) swallowed segment failure not affecting storage chunks, (c) live-poll partial emission during recording, (d) stop() halting the poll + segment recorder
- [ ] `npm test` exits 0 with 0 failures (all existing `test/browser.test.ts` tests still pass)
- [ ] `npm run build` exits 0
- [ ] `grep -n "audio/segments" src/session.ts` returns a match (segment upload wired)
- [ ] `grep -n "segment" src/types.ts` shows `segmentMs` added to `RecordOptions`
- [ ] `grep -n "enqueue\|reconcile\|uploadChunk\|runStop" src/session.ts` shows the storage-path methods still present and unmodified in signature (segments are additive)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the cited `src/session.ts` / `src/media.ts` / `src/types.ts` lines
  does not match "Current state" (the codebase has drifted since this plan was
  written).
- A **second** `MediaRecorder` on a fresh `getUserMedia` stream is not viable in
  the target runtime (e.g. only one recorder/mic-capture is permitted) — report it.
  The documented fallback is Web Audio PCM → WAV segments (capture raw PCM via an
  `AudioWorklet`/`ScriptProcessor` and encode fixed-length WAV files), which is a
  larger change than this plan scopes.
- This plan depends on backend plan 022 for the
  `scribe_sessions/:id/audio/segments` endpoint and the live-transcript field in
  `GET scribe_sessions/:id`. This is **not** a blocker for landing the SDK change:
  `liveTranscription` ships **off by default** (Step 6), so today's behavior is
  unchanged, and when a caller opts in, a missing endpoint just 404s and is
  harmlessly swallowed by the best-effort segment upload / live poll. Do not flip
  the default to `true` until backend 022 is confirmed live.
- A step's verification fails twice after a reasonable fix attempt.
- Implementing segments requires changing any storage-path method
  (`enqueue`/`reconcile`/`drain`/`uploadChunk`/`runStop` commit) — that means the
  design's isolation assumption is broken; report instead of proceeding.

## Maintenance notes

For the human/agent who owns this after the change lands:

- **Segment boundaries can clip words.** The fixed ~6 s cadence cuts mid-utterance.
  The documented mitigation is a silence-cut: a lightweight Web Audio RMS meter that
  restarts the segment recorder on a brief silence so the restart gap lands between
  words. This was deliberately deferred out of this plan (Step 1) to keep the first
  cut small; implement it as a follow-up if word-clipping hurts transcript quality.
  Transcript accuracy at the boundary is also improvable purely via a better ASR
  model, which is a backend config swap — no SDK change.
- **Isolation is the load-bearing invariant.** A reviewer must confirm segment
  capture and upload are fully independent of, and cannot regress, the plan-001
  durable storage path: segment failures are swallowed (`.catch(() => undefined)`),
  segment `stop()` cannot block `commit`, and no segment code mutates `nextSeq` /
  `buffer` / `queue` / `finalSeq`.
- **Flag parity.** `RecordOptions.liveTranscription` must stay aligned with the
  backend segments flag. It ships **default off**; flip the default to `true` (and/or
  drive it from a capability probe in a future iteration — deferred here) once
  backend plan 022 is confirmed live. Until then callers opt in per-call.
- **Underspecified defaults chosen** (smallest reasonable choice, flagged per the
  brief): `segmentMs` default `6000`, live-poll interval `1500 ms` (injectable via
  `RecordOptions.livePollIntervalMs`), `liveTranscription` default `false` until
  backend 022 is live. Tune against real ASR latency/cost once the backend endpoint
  is live.
