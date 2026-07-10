import { afterEach, describe, expect, it, vi } from "vitest";
import { createScribeClient } from "../src/index";
import {
  audioBlob,
  createFetchMock,
  formField,
  installMockRecorder,
  installMockSegmentRecorder,
  resp,
} from "./mocks";

const BASE = "https://api.example.test/api/v2";
const TOKEN = "mss_session_token";

/** GET /scribe_sessions/:id (no trailing path) — the live/result poll target. */
const SESSION_GET = /\/scribe_sessions\/[^/]+$/;

function statusOk() {
  return resp({ received_seqs: [], final_seen: false, bytes: 0 }, 200);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("segments: upload", () => {
  it("(a) POSTs each segment to /audio/segments with an incrementing seq + segment blob", async () => {
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) return statusOk();
      if (call.url.endsWith("/audio/segments")) return resp({ received: 0 }, 200);
      if (SESSION_GET.test(call.url) && call.method === "GET") {
        return resp({ id: "sess_seg", status: "processing", outputs: [] }, 202);
      }
      return resp({ error: "unexpected" }, 500);
    });

    installMockRecorder();
    const segments = installMockSegmentRecorder();
    const client = createScribeClient({
      baseUrl: BASE,
      getToken: () => TOKEN,
      fetch: mock.fn,
    });
    const session = client.session("sess_seg");

    await session.record({ liveTranscription: true, livePollIntervalMs: 1 });

    segments.emit(audioBlob("s0"));
    segments.emit(audioBlob("s1"));

    await vi.waitFor(() =>
      expect(mock.matching("/audio/segments", "POST").length).toBe(2),
    );

    const posts = mock.matching("/audio/segments", "POST");
    expect(posts[0]!.url).toBe(
      `${BASE}/scribe_sessions/sess_seg/audio/segments`,
    );
    expect(formField(posts[0]!.body, "seq")).toBe("0");
    expect(formField(posts[1]!.body, "seq")).toBe("1");
    // Each carries a `segment` blob field, not a string.
    expect(formField(posts[0]!.body, "segment")).toBe("[blob]");
    expect(formField(posts[1]!.body, "segment")).toBe("[blob]");
    expect(posts[0]!.bearer).toBe(TOKEN);
    expect(posts[1]!.bearer).toBe(TOKEN);
    // segmentMs default threaded through to the segment recorder.
    expect(segments.segmentMs()).toBe(3000);

    // Tear down so the live-poll setTimeout does not outlive the test.
    await session.cancel();
  });

  it("(b) swallows a segment upload failure without affecting storage chunks", async () => {
    const chunkPosts: number[] = [];
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) return statusOk();
      // Segments always fail — must be swallowed, never surfaced.
      if (call.url.endsWith("/audio/segments")) return resp({ error: "down" }, 500);
      if (call.url.endsWith("/audio/chunks")) {
        chunkPosts.push(Number(formField(call.body, "seq")));
        return resp({ received: 0 }, 200);
      }
      if (SESSION_GET.test(call.url) && call.method === "GET") {
        return resp({ id: "sess_segfail", status: "processing", outputs: [] }, 202);
      }
      return resp({ error: "unexpected" }, 500);
    });

    const recorder = installMockRecorder();
    const segments = installMockSegmentRecorder();
    const client = createScribeClient({
      baseUrl: BASE,
      getToken: () => TOKEN,
      fetch: mock.fn,
    });
    const session = client.session("sess_segfail");

    // record() must not reject even though the segment endpoint is 500ing.
    await expect(
      session.record({ liveTranscription: true, livePollIntervalMs: 1 }),
    ).resolves.toBeUndefined();

    // A failing segment upload does not throw out of the emit path.
    expect(() => segments.emit(audioBlob("seg"))).not.toThrow();

    // The durable storage chunk still uploads successfully to /audio/chunks.
    recorder.emit(audioBlob("chunk"));
    await vi.waitFor(() =>
      expect(mock.matching("/audio/chunks", "POST").length).toBe(1),
    );
    expect(chunkPosts).toEqual([0]);
    // The segment upload was attempted (and swallowed).
    expect(mock.matching("/audio/segments", "POST").length).toBe(1);

    // Tear down so the live-poll setTimeout does not outlive the test.
    await session.cancel();
  });
});

describe("segments: live transcript poll", () => {
  it("(c) polls GET /scribe_sessions/:id during recording and emits partials", async () => {
    const partials: string[] = [];
    let transcript = "";
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) return statusOk();
      if (call.url.endsWith("/audio/segments")) return resp({ received: 0 }, 200);
      if (SESSION_GET.test(call.url) && call.method === "GET") {
        // Growing transcript surfaced while still recording.
        transcript = transcript === "" ? "Hel" : "Hello world";
        return resp(
          {
            id: "sess_live",
            status: "processing",
            outputs: [
              {
                id: "o1",
                type: "transcript",
                status: "processing",
                result: { text: transcript },
              },
            ],
          },
          202,
        );
      }
      return resp({ error: "unexpected" }, 500);
    });

    installMockRecorder();
    installMockSegmentRecorder();
    const client = createScribeClient({
      baseUrl: BASE,
      getToken: () => TOKEN,
      fetch: mock.fn,
    });
    const session = client.session("sess_live");
    const statuses: string[] = [];
    session.onStatusChange((s) => statuses.push(s));
    session.onPartialTranscript((t) => partials.push(t));

    await session.record({ liveTranscription: true, livePollIntervalMs: 1 });

    // A partial arrives during recording, before stop().
    await vi.waitFor(() => expect(partials.length).toBeGreaterThanOrEqual(1));
    // Still recording (poll runs during recording, not after commit).
    expect(statuses).toContain("recording");
    expect(statuses).not.toContain("processing");
    expect(partials[0]).toBe("Hel");

    // Tear down so the live-poll setTimeout does not outlive the test.
    await session.cancel();
  });
});

describe("segments: stop teardown", () => {
  it("(d) stop() halts the live poll and stops the segment recorder", async () => {
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) return statusOk();
      if (call.url.endsWith("/audio/segments")) return resp({ received: 0 }, 200);
      if (call.url.endsWith("/audio/chunks")) return resp({ received: 0 }, 200);
      if (call.url.endsWith("/commit")) return resp({}, 202);
      if (SESSION_GET.test(call.url) && call.method === "GET") {
        return resp({ id: "sess_stop", status: "processing", outputs: [] }, 202);
      }
      return resp({ error: "unexpected" }, 500);
    });

    installMockRecorder();
    const segments = installMockSegmentRecorder();
    const client = createScribeClient({
      baseUrl: BASE,
      getToken: () => TOKEN,
      fetch: mock.fn,
    });
    const session = client.session("sess_stop");

    await session.record({ liveTranscription: true, livePollIntervalMs: 1 });

    // Let the poll run at least once so the "no further polls after stop" check
    // is meaningful.
    await vi.waitFor(() =>
      expect(mock.matching("/scribe_sessions/sess_stop", "GET").length).toBeGreaterThanOrEqual(1),
    );

    await session.stop();

    // The segment recorder was torn down.
    expect(segments.stopped()).toBe(true);

    // Snapshot the GET count using the real-URL regex (endsWith("/scribe_sessions/")
    // never matches — the URL ends in the session id). No further poll GETs fire
    // after stop().
    const countGets = () =>
      mock.calls.filter(
        (c) => SESSION_GET.test(c.url) && c.method === "GET",
      ).length;
    const afterStop = countGets();
    await new Promise((r) => setTimeout(r, 20));
    expect(countGets()).toBe(afterStop);
  });
});
