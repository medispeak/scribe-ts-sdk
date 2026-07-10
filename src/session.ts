import { ScribeError, errorFromResponse } from "./errors";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  RequestTimeoutError,
  SessionHttp,
  sleep,
} from "./http";
import {
  isTerminalStatus,
  mapSessionBody,
  type WireSessionBody,
} from "./mapping";
import { getRecorderFactory, type RecorderController } from "./media";
import { getChunkStore, type ChunkStore } from "./persistence";
import {
  getSegmentRecorderFactory,
  type SegmentController,
} from "./segments";
import type {
  RecordOptions,
  ResultOptions,
  ScribeResult,
  ScribeSession,
  ScribeStatus,
} from "./types";

const DEFAULT_CHUNK_MS = 5000;
// Short segments make the live transcript feel real-time: ASR latency is
// overhead-bound (~2s per call regardless of clip length), so a 2.5s segment
// costs almost the same as a 6s one but surfaces the first words ~3.5s sooner.
const DEFAULT_SEGMENT_MS = 2500;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LIVE_POLL_INTERVAL_MS = 700;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_UPLOAD_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 200;

/**
 * Internal construction options for {@link Session}.
 *
 * `retainLocalRecording` is surfaced publicly via `ScribeClientConfig`.
 * `uploadAttempts` / `backoffBase` are internal knobs (not part of the public
 * config surface) that tests use to disable real backoff sleeps and keep the
 * per-seq POST count deterministic.
 */
export interface SessionOptions {
  retainLocalRecording?: boolean;
  uploadAttempts?: number;
  backoffBase?: number;
}

/** Backend wire body for `GET /scribe_sessions/:id/audio/status`. */
interface AudioStatusBody {
  received_seqs?: number[];
  final_seen?: boolean;
  bytes?: number;
}

type Subscriber<T> = (value: T) => void;

/**
 * Concrete browser session. Owns the mic capture, resumable chunk upload,
 * commit, and result polling for one Medispeak scribe session.
 */
export class Session implements ScribeSession {
  readonly id: string;

  private readonly http: SessionHttp;

  private _status: ScribeStatus = "idle";
  private readonly statusSubs = new Set<Subscriber<ScribeStatus>>();
  private readonly partialSubs = new Set<Subscriber<string>>();
  private lastPartial: string | undefined;

  private controller: RecorderController | undefined;

  // Live transcription (best-effort, additive). A second standalone capture
  // emits independently-decodable segment files uploaded to the segments
  // endpoint, and a poll surfaces the growing transcript while still recording.
  // This stream is strictly isolated from the durable storage path above: a
  // segment failure is swallowed and never touches nextSeq/buffer/queue/finalSeq
  // or the commit. Gated by RecordOptions.liveTranscription (default off).
  private segmentController: SegmentController | undefined;
  private nextSegmentSeq = 0;
  private livePollTimer: ReturnType<typeof setTimeout> | undefined;
  private livePolling = false;

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

  // Durable source of truth. Every captured chunk is persisted here and kept
  // until the server acks the commit, so a reload/crash/hard failure never
  // destroys audio. `pendingPuts` tracks in-flight persistence writes so a
  // clear() can await them and never race a late put that would resurrect a
  // ghost session.
  private readonly store: ChunkStore;
  private readonly pendingPuts = new Set<Promise<void>>();

  // Bounded-retry knobs for the per-chunk upload. Defaults are production-safe;
  // tests override `uploadAttempts = 1` to keep POST counts deterministic/fast.
  private readonly uploadAttempts: number;
  private readonly backoffBase: number;
  // Keep the local recording after a successful commit (default false).
  private readonly retainLocalRecording: boolean;

  private stopping = false;
  private canceled = false;
  // Memoizes the in-flight stop() so concurrent calls share one commit.
  private stopPromise: Promise<void> | null = null;

  constructor(id: string, http: SessionHttp, opts: SessionOptions = {}) {
    this.id = id;
    this.http = http;
    this.store = getChunkStore();
    this.uploadAttempts = opts.uploadAttempts ?? DEFAULT_UPLOAD_ATTEMPTS;
    this.backoffBase = opts.backoffBase ?? DEFAULT_BACKOFF_BASE_MS;
    this.retainLocalRecording = opts.retainLocalRecording ?? false;
  }

  /* ----------------------------------------------------------------------
   * Status + subscriptions
   * -------------------------------------------------------------------- */

  private setStatus(status: ScribeStatus): void {
    if (status === this._status) return;
    this._status = status;
    for (const cb of this.statusSubs) cb(status);
  }

  get status(): ScribeStatus {
    return this._status;
  }

  onStatusChange(cb: Subscriber<ScribeStatus>): () => void {
    this.statusSubs.add(cb);
    return () => this.statusSubs.delete(cb);
  }

  onPartialTranscript(cb: Subscriber<string>): () => void {
    this.partialSubs.add(cb);
    return () => this.partialSubs.delete(cb);
  }

  private emitPartial(text: string): void {
    if (text === this.lastPartial) return;
    this.lastPartial = text;
    for (const cb of this.partialSubs) cb(text);
  }

  /* ----------------------------------------------------------------------
   * Recording lifecycle
   * -------------------------------------------------------------------- */

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

    // Live transcription is opt-in and strictly additive: it starts AFTER the
    // durable storage recorder is running and can never block it. Off by default
    // until backend plan 022 is live.
    const live = opts?.liveTranscription ?? false;
    if (live) {
      const segmentMs = opts?.segmentMs ?? DEFAULT_SEGMENT_MS;
      this.nextSegmentSeq = 0;
      try {
        this.segmentController = await getSegmentRecorderFactory()({
          segmentMs,
          onSegment: (b) => this.enqueueSegment(b),
        });
      } catch {
        // Best-effort: a segment-capture failure must never block the durable
        // storage recorder. Continue with storage-only capture.
        this.segmentController = undefined;
      }
      this.startLivePoll(
        opts?.livePollIntervalMs ?? DEFAULT_LIVE_POLL_INTERVAL_MS,
      );
    }
  }

  pause(): void {
    if (this._status !== "recording") return;
    this.controller?.pause();
    this.setStatus("paused");
  }

  resume(): void {
    if (this._status !== "paused") return;
    this.controller?.resume();
    this.setStatus("recording");
  }

  async stop(): Promise<void> {
    // Re-entrancy guard: a second concurrent stop() awaits the first instead of
    // issuing a duplicate commit. Set synchronously (before any await) so two
    // overlapping calls can never both pass the guards below.
    if (this.stopPromise) return this.stopPromise;
    if (this._status === "processing") return; // already committed
    if (this._status !== "recording" && this._status !== "paused") {
      throw new ScribeError("cannot stop: session is not recording");
    }

    this.stopPromise = this.runStop();
    try {
      await this.stopPromise;
    } finally {
      // Clear on completion: on success `status` is now `processing` (a later
      // stop() is a no-op); on failure the caller may retry.
      this.stopPromise = null;
    }
  }

  private async runStop(): Promise<void> {
    this.stopping = true;

    if (this.controller) {
      // Flushes the final chunk (marked via enqueue while `stopping`) and
      // releases the mic.
      await this.controller.stop();
      this.controller = undefined;
    }

    // Tear down the best-effort live-transcription stream. This is isolated
    // from the durable commit below: stopping the poll or a thrown segment
    // stop() must never prevent reconcile/commit.
    this.stopLivePoll();
    if (this.segmentController) {
      try {
        await this.segmentController.stop();
      } catch {
        // best-effort segment flush; must not block commit
      }
      this.segmentController = undefined;
    }

    // Fallback: if the recorder emitted no trailing chunk, mark the highest
    // produced seq as final so audio/status can report completeness.
    if (this.finalSeq === undefined && this.nextSeq > 0) {
      this.finalSeq = this.nextSeq - 1;
    }

    // On a terminal upload/commit failure, do NOT throw the recording away:
    // transition to `interrupted` (distinct from `failed`, which means the
    // server's processing failed) and leave everything in IndexedDB for retry().
    try {
      // Re-send anything the server is still missing (incl. the final chunk).
      await this.reconcile();
      const res = await this.http.request(`scribe_sessions/${this.id}/commit`, {
        method: "POST",
      });
      if (!res.ok) throw await errorFromResponse(res, "commit");
    } catch (err) {
      this.setStatus("interrupted");
      throw err;
    }
    await this.clearStore(); // Guarded by retainLocalRecording; awaits in-flight puts.
    this.setStatus("processing");
  }

  async cancel(): Promise<void> {
    // Set canceled first so enqueue() early-returns and enqueues no new puts;
    // the `pendingPuts` set clearStore() awaits below is therefore final.
    this.canceled = true;
    this.stopping = false;
    this.queue = [];
    // Best-effort teardown of the live-transcription stream (additive, isolated).
    this.stopLivePoll();
    if (this.segmentController) {
      try {
        await this.segmentController.stop();
      } catch {
        // best-effort segment stop
      }
      this.segmentController = undefined;
    }
    if (this.controller) {
      try {
        await this.controller.stop();
      } catch {
        // best-effort mic release
      }
      this.controller = undefined;
    }
    // The user abandoned the recording: drop the local copy (unless retained).
    await this.clearStore();
    this.setStatus("idle");
  }

  /* ----------------------------------------------------------------------
   * Durable recording: playback, retry, resume
   * -------------------------------------------------------------------- */

  /**
   * The local recording as one continuous Blob (all stored chunks concatenated
   * in seq order) plus an object URL, or undefined if nothing is stored. A
   * single MediaRecorder session produces one continuous file whose timeslice
   * chunks concatenate byte-for-byte, so naive concatenation is valid.
   */
  async localRecording(): Promise<{ url: string; blob: Blob } | undefined> {
    const chunks = await this.store.getAll(this.id);
    if (chunks.length === 0) return undefined;
    const ordered = chunks
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((c) => c.blob);
    const type = ordered[0]?.type || "audio/webm";
    const blob = new Blob(ordered, { type });
    return { url: URL.createObjectURL(blob), blob };
  }

  /**
   * Re-send any pending (un-acked) chunks and commit. Safe to call from
   * `interrupted` (a failed stop()) and after a reload via `client.resume()`.
   * A resumed session is `idle` and stop() throws for non-recording status, so
   * retry() — which runs reconcile()+flush()+commit and is safe from `idle` — is
   * the sole post-resume commit path.
   */
  async retry(): Promise<void> {
    await this.hydrate();
    // Final-seq fallback, mirroring runStop: hydrate restores finalSeq from the
    // persisted meta of the full set (incl. an already-acked final chunk), so
    // this only fires when NO persisted chunk was flagged final. nextSeq is now
    // derived from store.getAll, so nextSeq - 1 is the true highest produced seq.
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
    await this.clearStore();
    this.setStatus("processing");
  }

  /**
   * Re-load pending (un-acked) chunks from the store into the in-memory buffer
   * so a freshly constructed Session (over the same store, e.g. after a reload)
   * knows which seqs are pending before record()/retry() runs reconcile().
   */
  async hydrate(): Promise<void> {
    // Derive nextSeq and the final marker from the FULL persisted set, not just
    // the pending (un-acked) chunks. If the final (highest-seq) chunk was acked
    // before an interruption but the commit then failed, getPending() omits it —
    // so a pending-only derivation would under-count nextSeq and lose the final
    // seq, letting retry()'s fallback mis-mark an earlier chunk as final. Reading
    // the whole set keeps completeness correct across a resume: an already-acked
    // final chunk still restores finalSeq from its `{ final: true }` store meta.
    const all = await this.store.getAll(this.id);
    for (const { seq, meta } of all) {
      if (seq + 1 > this.nextSeq) this.nextSeq = seq + 1;
      if (meta?.final === true) this.finalSeq = seq;
    }
    // Only the un-acked tail needs re-buffering + re-queuing for re-send; acked
    // chunks are already durably on the server.
    const pending = await this.store.getPending(this.id);
    for (const { seq, blob } of pending) {
      this.buffer.set(seq, blob);
      if (!this.queue.includes(seq)) this.queue.push(seq);
    }
    this.queue.sort((a, b) => a - b);
  }

  /**
   * Remove the persisted recording — the ONLY call site of `store.clear`.
   * Invoked solely on the post-commit-ack success paths (runStop, retry) and on
   * cancel(). Awaits every in-flight enqueue put first so none lands after
   * clear() and resurrects a ghost session `listUnfinished()` would report
   * forever. Gated by `retainLocalRecording`.
   *
   * Invariant: cancel() sets `canceled = true` before calling this, so enqueue()
   * early-returns and the awaited `pendingPuts` set is final.
   */
  private async clearStore(): Promise<void> {
    if (this.retainLocalRecording) return;
    await Promise.allSettled([...this.pendingPuts]);
    await this.store.clear(this.id);
  }

  /* ----------------------------------------------------------------------
   * Chunk upload (buffered + resumable)
   * -------------------------------------------------------------------- */

  private enqueue(blob: Blob): void {
    if (this.canceled) return;
    const seq = this.nextSeq++;
    const isFinal = this.stopping;
    if (isFinal) this.finalSeq = seq;
    // Source of truth: persist before anything else. Swallow store errors so a
    // storage hiccup never drops capture; the in-memory buffer still lets the
    // live upload proceed. Persist final-ness in the store meta so it survives a
    // reload/retry: the resumed session must know which seq is the final one.
    this.trackPut(
      this.store.put(this.id, seq, blob, isFinal ? { final: true } : undefined),
    );
    this.buffer.set(seq, blob);
    this.queue.push(seq);
    // Live uploads: swallow transient errors here; they are retried by the
    // reconcile()+flush() at stop(), which surfaces failures to the caller.
    void this.drain().catch(() => undefined);
  }

  /**
   * Track an in-flight persistence `put` so {@link clearStore} can await it
   * before clearing — a put that resolves after clear() would re-insert a record
   * and leave a ghost session `listUnfinished()` reports forever. Store errors
   * are swallowed here so a storage hiccup never drops capture.
   */
  private trackPut(p: Promise<void>): void {
    const done = p
      .catch(() => undefined)
      .finally(() => {
        this.pendingPuts.delete(done);
      });
    this.pendingPuts.add(done);
  }

  /** Consult audio/status, mark received seqs, and re-enqueue what's missing. */
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

    // Continue numbering after the highest known seq (server-side).
    const maxReceived = received.length > 0 ? Math.max(...received) : -1;
    if (maxReceived + 1 > this.nextSeq) this.nextSeq = maxReceived + 1;

    // Re-queue any buffered chunk the server has not acknowledged.
    for (const seq of this.buffer.keys()) {
      if (!this.uploaded.has(seq) && !this.queue.includes(seq)) {
        this.queue.push(seq);
      }
    }
    this.queue.sort((a, b) => a - b);

    await this.flush();
  }

  /** Drain until the queue is empty, joining any in-flight drain. */
  private async flush(): Promise<void> {
    do {
      await this.drain();
    } while (this.queue.length > 0);
  }

  /** Single-flight uploader: concurrent callers await the same in-flight drain. */
  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.runDrain().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

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

  /**
   * Record a seq as durably uploaded and release its buffered Blob. Only the
   * unacknowledged tail is retained, bounding memory for long recordings while
   * keeping resume correct (reconcile re-queues only what's still buffered).
   */
  private markUploaded(seq: number): void {
    this.uploaded.add(seq);
    this.buffer.delete(seq);
    // Persisted copy is retained until commit; only mark it acked. Never
    // removed from the store here — only clearStore() (post-commit) deletes it.
    void this.store.markAcked(this.id, seq).catch(() => undefined);
  }

  /**
   * Upload one chunk with a bounded exponential backoff so a transient network
   * blip does not surface as a terminal failure. Attempts and base delay are
   * injectable (defaults 3 / 200ms); the final terminal failure is rethrown to
   * the drain, which surfaces it to the caller (stop()/retry()).
   */
  private async uploadChunk(
    seq: number,
    blob: Blob,
    final: boolean,
  ): Promise<void> {
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

  /* ----------------------------------------------------------------------
   * Live transcription (best-effort segments + during-recording poll)
   *
   * Strictly additive and isolated from the durable storage path: nothing here
   * mutates nextSeq/buffer/queue/finalSeq or can reject into stop()/commit. A
   * lost segment only costs a little live transcript.
   * -------------------------------------------------------------------- */

  /**
   * Assign a segment seq synchronously (preserving order) and fire-and-forget
   * its upload. A failed upload drops only that one segment and never rejects
   * into the storage path.
   */
  private enqueueSegment(blob: Blob): void {
    if (this.canceled) return;
    const seq = this.nextSegmentSeq++;
    // Best-effort: a lost segment only costs a little live transcript.
    void this.uploadSegment(seq, blob).catch(() => undefined);
  }

  /**
   * POST one standalone segment file to the segments endpoint. Mirrors
   * {@link uploadChunk}'s multipart shape but posts `seq` + `segment`. Does NOT
   * set a Content-Type header — the http wrapper derives the multipart boundary.
   */
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

  /**
   * Poll `GET scribe_sessions/:id` while recording and emit the growing
   * transcript via the existing partial channel, reusing the same GET + mapper
   * as {@link result}. Runs only until stopped (runStop/cancel); result() is the
   * authoritative post-commit poll. Errors are swallowed (best-effort).
   */
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

  /* ----------------------------------------------------------------------
   * Result polling
   * -------------------------------------------------------------------- */

  async result(opts?: ResultOptions): Promise<ScribeResult> {
    const interval = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeout;

    const timedOut = (): ScribeError =>
      new ScribeError(`result polling timed out after ${timeout}ms`, {
        status: undefined,
      });

    for (;;) {
      let body: WireSessionBody;
      try {
        // Bound each poll by the smaller of the default request timeout and the
        // caller's remaining deadline, so a stalled connection can't hang here.
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timedOut();
        body = await this.http.getJson<WireSessionBody>(
          `scribe_sessions/${this.id}`,
          "poll result",
          { timeoutMs: Math.min(DEFAULT_REQUEST_TIMEOUT_MS, remaining) },
        );
      } catch (err) {
        // A per-request timeout must not crash the loop: keep polling until the
        // overall deadline, then reject with a clear timeout. Genuine errors
        // (HTTP non-ok, network) propagate immediately, as before.
        if (err instanceof RequestTimeoutError) {
          if (Date.now() >= deadline) throw timedOut();
          await sleep(interval);
          continue;
        }
        throw err;
      }

      const mapped = mapSessionBody(body);

      if (mapped.transcript !== undefined) this.emitPartial(mapped.transcript);

      if (isTerminalStatus(body.status)) {
        this.setStatus(mapped.status === "failed" ? "failed" : "completed");
        return mapped;
      }

      if (Date.now() >= deadline) throw timedOut();
      await sleep(interval);
    }
  }
}
