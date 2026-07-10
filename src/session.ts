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
import type {
  RecordOptions,
  ResultOptions,
  ScribeResult,
  ScribeSession,
  ScribeStatus,
} from "./types";

const DEFAULT_CHUNK_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 120000;

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

  private stopping = false;
  private canceled = false;
  // Memoizes the in-flight stop() so concurrent calls share one commit.
  private stopPromise: Promise<void> | null = null;

  constructor(id: string, http: SessionHttp) {
    this.id = id;
    this.http = http;
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

  async cancel(): Promise<void> {
    this.canceled = true;
    this.stopping = false;
    this.queue = [];
    if (this.controller) {
      try {
        await this.controller.stop();
      } catch {
        // best-effort mic release
      }
      this.controller = undefined;
    }
    this.setStatus("idle");
  }

  /* ----------------------------------------------------------------------
   * Chunk upload (buffered + resumable)
   * -------------------------------------------------------------------- */

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
  }

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
