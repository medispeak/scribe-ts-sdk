/** Error thrown for any SDK-level or HTTP-level failure. */
export class ScribeError extends Error {
  /** HTTP status code, when the failure originated from a response. */
  readonly status?: number;
  /** Parsed response body (JSON when possible, else text), when available. */
  readonly body?: unknown;

  constructor(message: string, opts?: { status?: number; body?: unknown }) {
    super(message);
    this.name = "ScribeError";
    this.status = opts?.status;
    this.body = opts?.body;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, ScribeError.prototype);
  }
}

/** Build a ScribeError from a non-ok Response, reading its body best-effort. */
export async function errorFromResponse(
  res: Response,
  context: string,
): Promise<ScribeError> {
  let body: unknown;
  let detail = "";
  try {
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
        detail = ` — ${text.slice(0, 500)}`;
      } catch {
        body = text;
        detail = ` — ${text.slice(0, 500)}`;
      }
    }
  } catch {
    // ignore body read failures
  }
  return new ScribeError(
    `${context} failed: HTTP ${res.status}${detail}`,
    { status: res.status, body },
  );
}
