import { describe, expect, it } from "vitest";
import { createServerClient } from "../src/server";
import type { StartSessionOptions } from "../src/types";
import { createFetchMock, resp } from "./mocks";

const BASE = "https://api.example.test/api/v2";
const API_KEY = "msk_live_secret";

describe("server.createSession", () => {
  it("maps outputs to the backend wire shape and sends Bearer apiKey", async () => {
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/scribe_sessions") && call.method === "POST") {
        return resp({ id: "sess_1", status: "created", expires_at: "2026-07-11T00:00:00Z" }, 201);
      }
      return resp({ error: "unexpected" }, 500);
    });

    const client = createServerClient({ baseUrl: BASE, apiKey: API_KEY, fetch: mock.fn });

    const opts: StartSessionOptions = {
      outputs: [
        {
          type: "form",
          fields: [
            { key: "heart_rate", label: "Heart Rate", type: "number", description: "bpm", minimum: 0, maximum: 300 },
            { key: "on_insulin", label: "On insulin", type: "boolean" },
            { key: "severity", label: "Severity", type: "single_select", enum: ["mild", "moderate", "severe"] },
            { key: "symptoms", label: "Symptoms", type: "multi_select", enum: ["fever", "cough"] },
            { key: "notes", label: "Notes", type: "string" },
          ],
        },
        { type: "transcript" },
        { type: "note", templateRef: "tmpl_42" },
      ],
      language: ["auto"],
      mode: "consultation",
      callbackUrl: "https://app.example.test/webhooks/scribe",
    };

    const created = await client.createSession(opts);

    // Response mapping
    expect(created).toEqual({ id: "sess_1", status: "created", expiresAt: "2026-07-11T00:00:00Z" });

    // Request: route, auth, and body mapping
    const [call] = mock.matching("/scribe_sessions", "POST");
    expect(call).toBeDefined();
    expect(call!.url).toBe(`${BASE}/scribe_sessions`);
    expect(call!.bearer).toBe(API_KEY);
    expect(call!.headers["Content-Type"]).toBe("application/json");

    const sent = JSON.parse(call!.body as string);
    expect(sent.language_hint).toEqual(["auto"]);
    expect(sent.mode).toBe("consultation");
    expect(sent.callback_url).toBe("https://app.example.test/webhooks/scribe");

    expect(sent.outputs).toEqual([
      {
        type: "form",
        fields: [
          { key: "heart_rate", label: "Heart Rate", type: "number", description: "bpm", minimum: 0, maximum: 300 },
          { key: "on_insulin", label: "On insulin", type: "boolean" },
          { key: "severity", label: "Severity", type: "single_select", enum: ["mild", "moderate", "severe"] },
          { key: "symptoms", label: "Symptoms", type: "multi_select", enum: ["fever", "cough"] },
          { key: "notes", label: "Notes", type: "string" },
        ],
      },
      { type: "transcript" },
      { type: "note", template_ref: "tmpl_42" },
    ]);
  });

  it("omits undefined optional fields (no language/mode/callback)", async () => {
    const mock = createFetchMock(() => resp({ id: "s2", status: "created" }, 201));
    const client = createServerClient({ baseUrl: BASE, apiKey: API_KEY, fetch: mock.fn });

    await client.createSession({ outputs: [{ type: "transcript" }] });

    const sent = JSON.parse(mock.calls[0]!.body as string);
    expect(sent).toEqual({ outputs: [{ type: "transcript" }] });
    expect("language_hint" in sent).toBe(false);
    expect("mode" in sent).toBe(false);
    expect("callback_url" in sent).toBe(false);
  });

  it("throws a ScribeError on a non-ok response", async () => {
    const mock = createFetchMock(() => resp({ error: "quota" }, 422));
    const client = createServerClient({ baseUrl: BASE, apiKey: API_KEY, fetch: mock.fn });
    await expect(client.createSession({ outputs: [{ type: "transcript" }] })).rejects.toThrow(/HTTP 422/);
  });
});

describe("server.mintSessionToken", () => {
  it("hits the tokens route with Bearer apiKey and maps the response", async () => {
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/tokens") && call.method === "POST") {
        return resp({ token: "mss_abc", expires_at: "2026-07-10T00:05:00Z" }, 201);
      }
      return resp({ error: "unexpected" }, 500);
    });

    const client = createServerClient({ baseUrl: BASE, apiKey: API_KEY, fetch: mock.fn });
    const minted = await client.mintSessionToken("sess_1");

    expect(minted).toEqual({ token: "mss_abc", expiresAt: "2026-07-10T00:05:00Z" });

    const [call] = mock.matching("/tokens", "POST");
    expect(call!.url).toBe(`${BASE}/scribe_sessions/sess_1/tokens`);
    expect(call!.bearer).toBe(API_KEY);
  });
});
