import { ScribeError, errorFromResponse } from "./errors";

/**
 * Default per-request timeout. A single `fetch` that connects but never sends a
 * response body would otherwise hang forever; this bounds every request. Callers
 * (e.g. `result()` polling) may pass a smaller value bounded by their own deadline.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/** Thrown when a single request exceeds its per-request timeout and is aborted. */
export class RequestTimeoutError extends ScribeError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, RequestTimeoutError.prototype);
  }
}

/** Join a base URL and a path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  return `${b}/${p}`;
}

/** Remove keys whose value is `undefined` (shallow). */
export function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * A session-scoped, authenticated fetch wrapper.
 *
 * - Resolves the bearer token lazily via `getToken(sessionId)` and caches it.
 * - On any `401`, refreshes the token once (calls `getToken` again) and retries
 *   the request exactly once. Scoped tokens are short-lived and a long recording
 *   may outlast the TTL, so this refresh path is load-bearing.
 */
export class SessionHttp {
  private cachedToken: string | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string,
    private readonly getToken: (sessionId: string) => string | Promise<string>,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private async token(forceRefresh = false): Promise<string> {
    if (forceRefresh || this.cachedToken === undefined) {
      this.cachedToken = await this.getToken(this.sessionId);
    }
    return this.cachedToken;
  }

  /**
   * Perform an authed request against `path` (relative to the base URL).
   * The Authorization header is always set here, so callers must never set
   * their own headers (and must not set Content-Type for FormData bodies —
   * `fetch` derives the multipart boundary itself).
   *
   * Each attempt is bounded by a per-request timeout (`opts.timeoutMs`, default
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}). If the timeout fires, the underlying
   * `fetch` is aborted and a {@link RequestTimeoutError} is thrown so a stalled
   * connection can never hang the caller indefinitely.
   */
  async request(
    path: string,
    init: RequestInit = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<Response> {
    const url = joinUrl(this.baseUrl, path);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    const send = async (bearer: string): Promise<Response> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${bearer}`,
      };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new RequestTimeoutError(timeoutMs));
        }, Math.max(0, timeoutMs));
      });
      try {
        // Race the fetch against the timeout. `controller.abort()` cancels the
        // real request; the race guarantees we settle even if a fetch impl
        // ignores the signal.
        return await Promise.race([
          this.fetchImpl(url, { ...init, headers, signal: controller.signal }),
          timeout,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    let res = await send(await this.token());
    if (res.status === 401) {
      // Refresh the token once and retry — scoped tokens are short-lived.
      res = await send(await this.token(true));
    }
    return res;
  }

  /** Convenience: authed GET returning parsed JSON, throwing on non-ok. */
  async getJson<T>(
    path: string,
    context: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const res = await this.request(path, { method: "GET" }, opts);
    if (!res.ok) throw await errorFromResponse(res, context);
    return (await res.json()) as T;
  }
}
