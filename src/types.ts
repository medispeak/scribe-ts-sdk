/**
 * Shared, Medispeak-native types for the scribe SDK.
 *
 * These are the public wire-agnostic types used across all three entry points
 * (`.`, `./server`, `./react`). They are intentionally framework-agnostic and
 * describe sessions, outputs and fields in Medispeak's own vocabulary.
 */

/** The five native field types Medispeak can structure into. */
export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "single_select"
  | "multi_select";

/**
 * One field of an inline form the caller defines at runtime. Results come back
 * keyed by `key`.
 */
export interface FieldSpec {
  /** Result key (required, unique within a form). */
  key: string;
  /** Human-readable label used to prompt the model. */
  label: string;
  /** One of the five native field types. */
  type: FieldType;
  /** Optional free-text hint injected into the prompt. */
  description?: string;
  /** Allowed values — required for `single_select` / `multi_select`. */
  enum?: string[];
  /** Optional numeric lower bound (for `number`). */
  minimum?: number;
  /** Optional numeric upper bound (for `number`). */
  maximum?: number;
}

/**
 * A requested output. `transcript` returns the verbatim transcript, `note`
 * renders a narrative note (optionally from a stored template), and `form`
 * extracts an inline schema you define at runtime.
 */
export type OutputSpec =
  | { type: "transcript" }
  | { type: "note"; templateRef?: string }
  | { type: "form"; fields: FieldSpec[] };

/** Options for creating a scribe session (used by the server helper). */
export interface StartSessionOptions {
  /** The outputs to produce. */
  outputs: OutputSpec[];
  /**
   * Preferred language hints, e.g. `["auto"]` or `["en", "hi"]`. Note: the
   * backend stores a single language, so only the primary (first) hint is sent;
   * additional entries are accepted for forward compatibility but ignored today.
   */
  language?: string[];
  /** Recording mode. */
  mode?: "consultation" | "dictation";
  /** Optional webhook the backend calls when processing finishes. */
  callbackUrl?: string;
}

/** One processed output as returned by the backend. */
export interface ScribeOutputResult {
  id: string;
  type: string;
  status: string;
  result?: unknown;
  errors?: unknown;
}

/** The mapped, terminal result of a scribe session. */
export interface ScribeResult {
  status: "completed" | "partial" | "failed";
  /** The verbatim transcript, if a transcript output was produced. */
  transcript?: string;
  /** Shallow merge of every `form` output's `{ key: value }` result. */
  structuredData?: Record<string, unknown>;
  /** The raw per-output results. */
  outputs: ScribeOutputResult[];
}

/** The lifecycle status of a browser session. */
export type ScribeStatus =
  | "idle"
  | "recording"
  | "paused"
  | "processing"
  | "interrupted" // upload/commit could not reach/complete the server
  | "completed"
  | "failed";

/* --------------------------------------------------------------------------
 * Browser client (entry point `.`)
 * ------------------------------------------------------------------------ */

export interface ScribeClientConfig {
  /** The v2 API root, e.g. `https://api.example.com/api/v2`. */
  baseUrl: string;
  /**
   * Returns a short-lived, session-scoped bearer token for `sessionId`.
   * Called lazily, cached, and re-invoked once on a `401` (token refresh).
   * May be sync or async.
   */
  getToken: (sessionId: string) => string | Promise<string>;
  /** Optional `fetch` implementation (defaults to the global `fetch`). */
  fetch?: typeof fetch;
  /** Keep the local recording in the store after a successful commit (default false). */
  retainLocalRecording?: boolean;
}

export interface RecordOptions {
  /** MediaRecorder timeslice in ms (default 5000). */
  chunkMs?: number;
  /** Standalone transcription-segment duration in ms (default 6000). */
  segmentMs?: number;
  /**
   * Live-transcript poll interval in ms (default 1500). Injectable so tests
   * can pass a tiny value (mirrors `result()`'s `pollIntervalMs`).
   */
  livePollIntervalMs?: number;
  /**
   * Capture standalone segments + poll a live transcript during recording.
   * Defaults to `false` until backend plan 022 is confirmed live (lockstep with
   * the backend segments flag); set `true` to opt in to live capture once the
   * endpoint ships. When `false`, behavior is storage-only capture (post-commit
   * transcript only).
   */
  liveTranscription?: boolean;
  /**
   * Stream the mic DIRECTLY to the realtime provider (OpenAI) for
   * low-latency live transcription, via a backend-minted ephemeral token.
   * Replaces the segment-poll live path when set. The durable storage recorder
   * still runs and remains the authoritative source for the committed
   * transcript, so realtime is a pure live-UX overlay. Best-effort: if the
   * realtime connection fails, capture + commit are unaffected. Requires the
   * backend SCRIBE_REALTIME flag. Defaults to `false`.
   */
  realtime?: boolean;
}

export interface ResultOptions {
  /** Poll interval in ms (default 2000). */
  pollIntervalMs?: number;
  /** Give up after this many ms (default 120000). */
  timeoutMs?: number;
}

export interface ScribeSession {
  readonly id: string;
  /** Start mic capture and stream chunks. Resumes if the session already has chunks. */
  record(opts?: RecordOptions): Promise<void>;
  /** Pause capture (uploads already in flight continue). */
  pause(): void;
  /** Resume capture after a pause. */
  resume(): void;
  /** Finalize the upload, then commit the session for processing. */
  stop(): Promise<void>;
  /** Abandon the session: stop capture and release the mic without committing. */
  cancel(): Promise<void>;
  /** Poll until a terminal status and return the mapped result. */
  result(opts?: ResultOptions): Promise<ScribeResult>;
  /**
   * The local recording as one continuous Blob (all stored chunks concatenated
   * in seq order) plus an object URL, or undefined if nothing is stored.
   */
  localRecording(): Promise<{ url: string; blob: Blob } | undefined>;
  /** Re-send any pending chunks and commit. Use after an `interrupted` status. */
  retry(): Promise<void>;
  /** Subscribe to partial transcript updates. Returns an unsubscribe function. */
  onPartialTranscript(cb: (text: string) => void): () => void;
  /** Subscribe to status changes. Returns an unsubscribe function. */
  onStatusChange(cb: (s: ScribeStatus) => void): () => void;
}

export interface ScribeClient {
  /** Bind to an existing session id (created + token-minted by your backend). */
  session(sessionId: string): ScribeSession;
  /**
   * Rebuild a session from locally persisted chunks (e.g. after a reload) and
   * re-hydrate its pending seqs. The caller then invokes `retry()` to reconcile
   * and commit — a resumed session is `idle`, so `stop()` would throw.
   */
  resume(sessionId: string): Promise<ScribeSession>;
}

/* --------------------------------------------------------------------------
 * Server helper (entry point `./server`)
 * ------------------------------------------------------------------------ */

export interface ServerClientConfig {
  /** The v2 API root, e.g. `https://api.example.com/api/v2`. */
  baseUrl: string;
  /** The account secret (`msk_live_…`). Never ship this to a browser. */
  apiKey: string;
  /** Optional `fetch` implementation (defaults to the global `fetch`). */
  fetch?: typeof fetch;
}

export interface CreatedSession {
  id: string;
  status: string;
  expiresAt?: string;
}

export interface MintedToken {
  token: string;
  expiresAt: string;
}

export interface ScribeServerClient {
  createSession(opts: StartSessionOptions): Promise<CreatedSession>;
  mintSessionToken(sessionId: string): Promise<MintedToken>;
}

/* --------------------------------------------------------------------------
 * React hook (entry point `./react`)
 * ------------------------------------------------------------------------ */

export interface UseScribeOptions {
  client: ScribeClient;
  sessionId: string;
  onResult?(r: ScribeResult): void;
  onError?(e: Error): void;
}

export interface UseScribeReturn {
  status: ScribeStatus;
  isRecording: boolean;
  isPaused: boolean;
  duration: number;
  result: ScribeResult | null;
  error: string | null;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
  cancel(): Promise<void>;
}
