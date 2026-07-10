# @medispeak/scribe-ts-sdk

The Medispeak-native browser scribe SDK. Record a consultation in the browser,
stream it to Medispeak, and get back a transcript and/or an auto-filled form —
**without ever holding an account secret in the browser**.

The SDK talks only to Medispeak's documented v2 API. Its public types are
Medispeak-native (sessions, outputs, fields) and framework-agnostic; a thin
React hook is provided as a separate, optional entry point.

- **Zero secrets in the browser.** The browser authenticates with a short-lived,
  single-session token minted by *your* backend from its account key.
- **Resumable capture.** Audio is chunked (~5 s segments) and uploaded as it is
  recorded; on a network drop the SDK consults the server and re-sends only the
  missing chunks.
- **Runtime forms.** Define the fields you want extracted at record time; results
  come back keyed by your own field `key`s. No pre-created templates required.
- **Three entry points**, tree-shakeable, shipped as ESM + CJS with types.

---

## Install

```bash
npm install @medispeak/scribe-ts-sdk
```

`react` is an **optional peer dependency** — it is only needed if you import the
`@medispeak/scribe-ts-sdk/react` entry point. The core and server entry points
have no runtime dependencies.

| Import path | Runs in | Purpose |
| --- | --- | --- |
| `@medispeak/scribe-ts-sdk` | Browser | Record, upload, commit, poll for results. |
| `@medispeak/scribe-ts-sdk/server` | Your Node backend | Create sessions + mint scoped tokens with the account secret. |
| `@medispeak/scribe-ts-sdk/react` | Browser (React) | `useScribe` hook wrapping the browser client. |

---

## The token flow (why there are two clients)

The account secret (`msk_live_…`) must **never** reach a browser. Instead your
backend creates the session and mints a short-lived, session-scoped token that
can only upload to and read that one session. The browser SDK holds only that
token.

```
  ┌──────────────────────────┐                         ┌──────────────────────────┐
  │      Your app backend     │                         │     Browser (the SDK)     │
  │   holds msk_live_ secret   │                         │  holds only a scoped token │
  └────────────┬─────────────┘                         └─────────────┬────────────┘
               │                                                       │
   createSession(outputs)                                             │
   POST /scribe_sessions  ──────────────► Medispeak v2 ──► 201 { id } │
               │                                                       │
   mintSessionToken(id)                                               │
   POST /scribe_sessions/:id/tokens ────► Medispeak v2 ──► { token }  │
               │                                                       │
               │   hand { id, token } to the browser ────────────────►│
               │                                                       │
               │                        record()  ─ Bearer token ─►  POST /:id/audio/chunks
               │                        stop()     ─ Bearer token ─►  POST /:id/commit
               │                        result()   ─ Bearer token ─►  GET  /:id  (poll)
               │                                                       │
               │◄──── optional HMAC webhook (callbackUrl) ────────────┤
```

1. **Backend** creates the session with the outputs you want (including any
   inline `form` fields) using its account key, then mints a scoped token.
2. **Backend** hands `{ id, token }` to the browser however it likes (page render,
   JSON endpoint, etc.). The browser's `getToken` provider returns that token —
   and can re-fetch a fresh one, which the SDK calls automatically on a `401`
   (scoped tokens are short-lived; a long consultation may outlast the TTL).
3. **Browser** records, uploads, commits, and polls — all scoped to that session.

---

## Server usage (`@medispeak/scribe-ts-sdk/server`)

Runs on your backend. Uses the account secret. Never bundle this into browser code.

```ts
import { createServerClient } from "@medispeak/scribe-ts-sdk/server";
import type { FieldSpec } from "@medispeak/scribe-ts-sdk/server";

const server = createServerClient({
  baseUrl: "https://api.medispeak.example/api/v2",
  apiKey: process.env.MEDISPEAK_API_KEY!, // msk_live_…
});

const fields: FieldSpec[] = [
  { key: "heart_rate", label: "Heart Rate", type: "number", description: "beats per minute", minimum: 0, maximum: 300 },
  { key: "on_insulin", label: "On insulin", type: "boolean" },
  { key: "severity",   label: "Severity",   type: "single_select", enum: ["mild", "moderate", "severe"] },
  { key: "symptoms",   label: "Symptoms",   type: "multi_select",  enum: ["fever", "cough", "fatigue"] },
];

// 1) Create the session (returns { id, status, expiresAt })
const session = await server.createSession({
  outputs: [{ type: "form", fields }, { type: "transcript" }],
  language: ["auto"],
  mode: "consultation",
  callbackUrl: "https://app.example/webhooks/scribe", // optional HMAC webhook
});

// 2) Mint a scoped token for the browser (returns { token, expiresAt })
const { token } = await server.mintSessionToken(session.id);

// 3) Send { id: session.id, token } to the browser.
```

**Output types**

| `OutputSpec` | Result |
| --- | --- |
| `{ type: "transcript" }` | Verbatim transcript. |
| `{ type: "note", templateRef? }` | Narrative note, optionally from a stored template. |
| `{ type: "form", fields }` | Structured extraction against the inline `fields` you define. |

**Field types** (`FieldType`): `string`, `number`, `boolean`, `single_select`
(needs `enum`), `multi_select` (needs `enum`). `minimum`/`maximum` apply to
`number`.

---

## Browser usage (`@medispeak/scribe-ts-sdk`)

```ts
import { createScribeClient } from "@medispeak/scribe-ts-sdk";

const client = createScribeClient({
  baseUrl: "https://api.medispeak.example/api/v2",
  // Return the scoped token for this session from your backend.
  // Called lazily, cached, and re-invoked once on a 401 to refresh.
  getToken: async (sessionId) => {
    const res = await fetch(`/api/scribe/${sessionId}/token`);
    const { token } = await res.json();
    return token;
  },
});

const session = client.session(sessionIdFromBackend);

// Live status + partial transcript subscriptions (both return unsubscribers).
const off = session.onStatusChange((s) => console.log("status:", s));
session.onPartialTranscript((text) => console.log("partial:", text));

await session.record();          // asks for the mic, streams ~5 s chunks
// session.pause(); session.resume();
await session.stop();            // flush the final chunk, then commit

const result = await session.result(); // polls until a terminal status
console.log(result.status);             // "completed" | "partial" | "failed"
console.log(result.transcript);         // string | undefined
console.log(result.structuredData);     // { heart_rate: 72, severity: "mild", ... }

off();
```

### `createScribeClient(config)`

| Option | Type | Notes |
| --- | --- | --- |
| `baseUrl` | `string` | The v2 API root, e.g. `https://…/api/v2`. |
| `getToken` | `(sessionId) => string \| Promise<string>` | Returns the scoped token. |
| `fetch` | `typeof fetch` | Optional; defaults to the global `fetch`. |

### `ScribeSession`

| Member | Description |
| --- | --- |
| `id` | The session id. |
| `record(opts?)` | Start mic capture + chunk streaming. `opts.chunkMs` (default `5000`). Resumes automatically if the session already has chunks. |
| `pause()` / `resume()` | Pause/resume capture. In-flight uploads continue. |
| `stop()` | Finalize the upload, then commit the session for processing. |
| `cancel()` | Stop capture and release the mic **without** committing. |
| `result(opts?)` | Poll `GET /:id` until a terminal status. `opts.pollIntervalMs` (default `2000`), `opts.timeoutMs` (default `120000`). Resolves to a `ScribeResult`. |
| `onPartialTranscript(cb)` | Subscribe to partial transcript text. Returns an unsubscribe fn. |
| `onStatusChange(cb)` | Subscribe to `ScribeStatus` changes. Returns an unsubscribe fn. |

`ScribeStatus`: `idle → recording ⇄ paused → processing → completed | failed`.

### Result mapping

`result()` maps Medispeak's raw `outputs[]` into a friendly shape:

- **`transcript`** — the `transcript` output's `result.text` (falling back to any
  output whose result carries a `text`).
- **`structuredData`** — a shallow merge of every `form` output's `result` object
  (each already `{ key: value }`), so multiple forms combine into one map.
- **`outputs`** — the raw per-output results are always available for advanced use.

---

## React usage (`@medispeak/scribe-ts-sdk/react`)

```tsx
import { createScribeClient } from "@medispeak/scribe-ts-sdk";
import { useScribe } from "@medispeak/scribe-ts-sdk/react";

const client = createScribeClient({ baseUrl, getToken });

function ScribeButton({ sessionId }: { sessionId: string }) {
  const scribe = useScribe({
    client,
    sessionId,
    onResult: (r) => console.log("done", r.structuredData),
    onError: (e) => console.error(e),
  });

  return (
    <div>
      <p>Status: {scribe.status} · {scribe.duration}s</p>
      {!scribe.isRecording && !scribe.isPaused && (
        <button onClick={scribe.start}>Record</button>
      )}
      {scribe.isRecording && <button onClick={scribe.pause}>Pause</button>}
      {scribe.isPaused && <button onClick={scribe.resume}>Resume</button>}
      {(scribe.isRecording || scribe.isPaused) && (
        <button onClick={scribe.stop}>Stop</button>
      )}
      {scribe.error && <p role="alert">{scribe.error}</p>}
      {scribe.result?.transcript && <pre>{scribe.result.transcript}</pre>}
    </div>
  );
}
```

`useScribe(options)` returns `{ status, isRecording, isPaused, duration, result,
error, start, pause, resume, stop, cancel }`. `stop()` commits **and** resolves
the result (calling `onResult`). `duration` counts seconds while recording and
freezes on pause.

---

## Errors

All HTTP and SDK failures throw a `ScribeError` (exported from `.` and
`./server`) with optional `status` and parsed `body`:

```ts
import { ScribeError } from "@medispeak/scribe-ts-sdk";

try {
  await session.stop();
} catch (e) {
  if (e instanceof ScribeError) console.error(e.status, e.body);
}
```

---

## Wire protocol

The SDK targets Medispeak's v2 routes:

| Call | Route | Auth |
| --- | --- | --- |
| `server.createSession` | `POST /scribe_sessions` | `Bearer msk_live_…` |
| `server.mintSessionToken` | `POST /scribe_sessions/:id/tokens` | `Bearer msk_live_…` |
| `record()` chunk | `POST /scribe_sessions/:id/audio/chunks` (multipart: `seq`, `chunk`, optional `final`) | `Bearer <session token>` |
| `record()` resume | `GET /scribe_sessions/:id/audio/status` | `Bearer <session token>` |
| `stop()` | `POST /scribe_sessions/:id/commit` | `Bearer <session token>` |
| `result()` | `GET /scribe_sessions/:id` (`202` processing · `200` completed · `206` partial) | `Bearer <session token>` |

---

## Development

```bash
npm install
npm run build       # tsup → ESM + CJS + .d.ts for all three entry points
npm test            # vitest (jsdom), mocked fetch + MediaRecorder
npm run typecheck   # tsc --noEmit (strict)
```

Tests mock `fetch` (injected via config) and the microphone (an injectable
recorder factory, since jsdom has no `MediaRecorder`).

## License

MIT
