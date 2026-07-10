import { vi } from "vitest";
import { setRecorderFactory, type RecorderFactory } from "../src/media";
import { MemoryChunkStore, setChunkStore } from "../src/persistence";

/** A minimal Response-like object exposing just what the SDK reads. */
export function resp(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    text: async () => text,
  } as unknown as Response;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  bearer?: string;
}

export interface FetchMock {
  fn: typeof fetch;
  calls: RecordedCall[];
  /** Calls whose URL ends with `suffix` (optionally filtered by method). */
  matching(suffix: string, method?: string): RecordedCall[];
}

/**
 * Build a recording fetch mock. `handler` receives each parsed call and returns
 * a Response (or throws). Every call (url/method/headers/body/bearer) is logged.
 */
export function createFetchMock(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): FetchMock {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = (init.headers as Record<string, string>) ?? {};
    const bearerHeader = headers["Authorization"] ?? headers["authorization"];
    const call: RecordedCall = {
      url: String(input),
      method: (init.method ?? "GET").toUpperCase(),
      headers,
      body: init.body,
      bearer: bearerHeader?.replace(/^Bearer\s+/, ""),
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;

  return {
    fn,
    calls,
    matching(suffix: string, method?: string) {
      return calls.filter(
        (c) =>
          c.url.endsWith(suffix) &&
          (method === undefined || c.method === method.toUpperCase()),
      );
    },
  };
}

/** Read a FormData field as a string (seq / final). */
export function formField(body: unknown, name: string): string | null {
  const fd = body as FormData;
  const value = fd.get(name);
  return typeof value === "string" ? value : value === null ? null : "[blob]";
}

/** True when the FormData `chunk` field is present (a Blob/File). */
export function hasChunkBlob(body: unknown): boolean {
  const fd = body as FormData;
  const value = fd.get("chunk");
  return value !== null && typeof value !== "string";
}

export interface MockRecorderHandle {
  /** Emit an interim audio chunk (as MediaRecorder would each timeslice). */
  emit(blob: Blob): void;
  /** Configure the trailing chunk flushed on stop() (like a real recorder). */
  setFinalChunk(blob: Blob | null): void;
  paused(): boolean;
  stopped(): boolean;
  chunkMs(): number | undefined;
}

/** Install a fake recorder factory and return a handle to drive it. */
export function installMockRecorder(): MockRecorderHandle {
  const state: {
    onChunk?: (blob: Blob) => void;
    chunkMs?: number;
    paused: boolean;
    stopped: boolean;
    finalChunk: Blob | null;
  } = { paused: false, stopped: false, finalChunk: null };

  const factory: RecorderFactory = async ({ chunkMs, onChunk }) => {
    state.onChunk = onChunk;
    state.chunkMs = chunkMs;
    return {
      pause() {
        state.paused = true;
      },
      resume() {
        state.paused = false;
      },
      async stop() {
        if (state.finalChunk && state.onChunk) state.onChunk(state.finalChunk);
        state.stopped = true;
      },
    };
  };

  setRecorderFactory(factory);

  return {
    emit(blob) {
      state.onChunk?.(blob);
    },
    setFinalChunk(blob) {
      state.finalChunk = blob;
    },
    paused: () => state.paused,
    stopped: () => state.stopped,
    chunkMs: () => state.chunkMs,
  };
}

/** A tiny audio blob for tests. */
export function audioBlob(label = "audio"): Blob {
  return new Blob([label], { type: "audio/webm" });
}

/**
 * Install an in-memory chunk store (mirrors installMockRecorder) and return it
 * as the handle: MemoryChunkStore already exposes getAll/getPending/
 * listUnfinished/clear for assertions. Tests call resetChunkStore() in afterEach.
 */
export function installMemoryChunkStore(): MemoryChunkStore {
  const store = new MemoryChunkStore();
  setChunkStore(store);
  return store;
}
