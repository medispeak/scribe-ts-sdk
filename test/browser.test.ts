import { describe, expect, it, vi } from "vitest";
import { createScribeClient } from "../src/index";
import {
  audioBlob,
  createFetchMock,
  formField,
  hasChunkBlob,
  installMockRecorder,
  resp,
  type RecordedCall,
} from "./mocks";

const BASE = "https://api.example.test/api/v2";
const TOKEN = "mss_session_token";

function statusOk() {
  return resp({ received_seqs: [], final_seen: false, bytes: 0 }, 200);
}

describe("browser: chunk upload", () => {
  it("POSTs multipart form-data with seq + chunk blob and Bearer session token", async () => {
    const chunkPosts: RecordedCall[] = [];
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) return statusOk();
      if (call.url.endsWith("/audio/chunks")) {
        chunkPosts.push(call);
        return resp({ received: Number(formField(call.body, "seq")) }, 200);
      }
      return resp({ error: "unexpected" }, 500);
    });

    const recorder = installMockRecorder();
    const client = createScribeClient({
      baseUrl: BASE,
      getToken: () => TOKEN,
      fetch: mock.fn,
    });
    const session = client.session("sess_1");

    await session.record();
    recorder.emit(audioBlob("a"));

    await vi.waitFor(() => expect(chunkPosts.length).toBe(1));

    const call = chunkPosts[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE}/scribe_sessions/sess_1/audio/chunks`);
    expect(call.bearer).toBe(TOKEN);
    expect(formField(call.body, "seq")).toBe("0");
    expect(hasChunkBlob(call.body)).toBe(true);
    // default chunk timeslice
    expect(recorder.chunkMs()).toBe(5000);
  });

  it("passes a custom chunkMs to the recorder", async () => {
    const mock = createFetchMock(() => statusOk());
    const recorder = installMockRecorder();
    const client = createScribeClient({ baseUrl: BASE, getToken: () => TOKEN, fetch: mock.fn });
    await client.session("s").record({ chunkMs: 2000 });
    expect(recorder.chunkMs()).toBe(2000);
  });
});

describe("browser: resume", () => {
  it("consults audio/status and does not re-send already-received seqs", async () => {
    const chunkSeqs: string[] = [];
    let statusCalls = 0;
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) {
        statusCalls++;
        return resp({ received_seqs: [0, 1, 2], final_seen: false, bytes: 30 }, 200);
      }
      if (call.url.endsWith("/audio/chunks")) {
        chunkSeqs.push(formField(call.body, "seq")!);
        return resp({ received: 0 }, 200);
      }
      return resp({ error: "unexpected" }, 500);
    });

    const recorder = installMockRecorder();
    const client = createScribeClient({ baseUrl: BASE, getToken: () => TOKEN, fetch: mock.fn });
    const session = client.session("sess_2");

    await session.record();
    recorder.emit(audioBlob("d"));
    recorder.emit(audioBlob("e"));

    await vi.waitFor(() => expect(chunkSeqs.length).toBe(2));

    expect(statusCalls).toBeGreaterThanOrEqual(1);
    // Numbering continues after the highest received seq (2) → 3, 4.
    expect(chunkSeqs).toEqual(["3", "4"]);
    // None of the already-received seqs were re-sent.
    expect(chunkSeqs).not.toContain("0");
    expect(chunkSeqs).not.toContain("1");
    expect(chunkSeqs).not.toContain("2");
  });

  it("re-sends only the missing seqs after a mid-recording upload drop", async () => {
    const posts: { seq: string; final: string | null; status: number }[] = [];
    const state = { received: [] as number[], failSeqs: new Set<number>() };

    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) {
        return resp({ received_seqs: state.received, final_seen: false, bytes: 0 }, 200);
      }
      if (call.url.endsWith("/audio/chunks")) {
        const seq = formField(call.body, "seq")!;
        const fail = state.failSeqs.has(Number(seq));
        posts.push({ seq, final: formField(call.body, "final"), status: fail ? 500 : 200 });
        return resp(fail ? { error: "net" } : { received: Number(seq) }, fail ? 500 : 200);
      }
      if (call.url.endsWith("/commit")) return resp({}, 202);
      return resp({ error: "unexpected" }, 500);
    });

    const recorder = installMockRecorder();
    recorder.setFinalChunk(audioBlob("final"));
    const client = createScribeClient({ baseUrl: BASE, getToken: () => TOKEN, fetch: mock.fn });
    const session = client.session("sess_3");

    await session.record();

    // seq 0 uploads fine.
    recorder.emit(audioBlob("0"));
    await vi.waitFor(() => expect(posts.filter((p) => p.status === 200).length).toBe(1));

    // Network drops: seq 1 fails; seq 2 gets queued behind it.
    state.failSeqs = new Set([1]);
    recorder.emit(audioBlob("1"));
    recorder.emit(audioBlob("2"));
    await vi.waitFor(() => expect(posts.some((p) => p.seq === "1" && p.status === 500)).toBe(true));

    // Recovery: network back, server confirms it only got seq 0.
    state.failSeqs = new Set();
    state.received = [0];

    await session.stop(); // reconcile → re-send missing (1, 2) + final chunk (3) → commit

    const ok = posts.filter((p) => p.status === 200);
    const okSeqs = new Set(ok.map((p) => p.seq));
    expect(okSeqs).toEqual(new Set(["0", "1", "2", "3"]));
    // seq 0 was already received → never re-POSTed successfully more than once.
    expect(ok.filter((p) => p.seq === "0").length).toBe(1);
    // The trailing chunk carries the final flag.
    expect(posts.find((p) => p.seq === "3")?.final).toBe("true");
    // commit fired.
    expect(mock.matching("/commit", "POST").length).toBe(1);
  });
});

describe("browser: stop", () => {
  it("finalizes the upload then calls commit and moves to processing", async () => {
    const statuses: string[] = [];
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) return statusOk();
      if (call.url.endsWith("/audio/chunks")) return resp({ received: 0 }, 200);
      if (call.url.endsWith("/commit")) return resp({}, 202);
      return resp({ error: "unexpected" }, 500);
    });

    const recorder = installMockRecorder();
    recorder.setFinalChunk(audioBlob("tail"));
    const client = createScribeClient({ baseUrl: BASE, getToken: () => TOKEN, fetch: mock.fn });
    const session = client.session("sess_4");
    session.onStatusChange((s) => statuses.push(s));

    await session.record();
    recorder.emit(audioBlob("x"));
    await session.stop();

    const commits = mock.matching("/commit", "POST");
    expect(commits.length).toBe(1);
    expect(commits[0]!.bearer).toBe(TOKEN);
    expect(statuses).toContain("recording");
    expect(statuses).toContain("processing");
    expect(recorder.stopped()).toBe(true);
  });
});

describe("browser: result polling", () => {
  it("polls until terminal and maps transcript + merged structuredData", async () => {
    const partials: string[] = [];
    let poll = 0;
    const mock = createFetchMock((call) => {
      if (/\/scribe_sessions\/[^/]+$/.test(call.url) && call.method === "GET") {
        poll++;
        if (poll === 1) {
          return resp(
            { id: "sess_5", status: "processing", outputs: [{ id: "o1", type: "transcript", status: "processing", result: { text: "Hel" } }] },
            202,
          );
        }
        return resp(
          {
            id: "sess_5",
            status: "completed",
            outputs: [
              { id: "o1", type: "transcript", status: "completed", result: { text: "Hello world" } },
              { id: "o2", type: "form", status: "completed", result: { heart_rate: 72, on_insulin: true } },
              { id: "o3", type: "form", status: "completed", result: { severity: "mild" } },
            ],
          },
          200,
        );
      }
      return resp({ error: "unexpected" }, 500);
    });

    const client = createScribeClient({ baseUrl: BASE, getToken: () => TOKEN, fetch: mock.fn });
    const session = client.session("sess_5");
    session.onPartialTranscript((t) => partials.push(t));

    const result = await session.result({ pollIntervalMs: 1, timeoutMs: 1000 });

    expect(poll).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("completed");
    expect(result.transcript).toBe("Hello world");
    expect(result.structuredData).toEqual({ heart_rate: 72, on_insulin: true, severity: "mild" });
    expect(result.outputs).toHaveLength(3);
    // partial transcripts were surfaced as they changed
    expect(partials).toEqual(["Hel", "Hello world"]);
  });

  it("maps a partial terminal status", async () => {
    const mock = createFetchMock(() =>
      resp(
        {
          id: "sp",
          status: "partial",
          outputs: [
            { id: "o1", type: "transcript", status: "completed", result: { text: "partial text" } },
            { id: "o2", type: "form", status: "failed", result: null, errors: ["extraction failed"] },
          ],
        },
        206,
      ),
    );
    const client = createScribeClient({ baseUrl: BASE, getToken: () => TOKEN, fetch: mock.fn });
    const result = await client.session("sp").result({ pollIntervalMs: 1 });
    expect(result.status).toBe("partial");
    expect(result.transcript).toBe("partial text");
    // no valid form result object → structuredData omitted
    expect(result.structuredData).toBeUndefined();
  });
});

describe("browser: auth refresh", () => {
  it("refreshes the token once on a 401 and retries", async () => {
    const getToken = vi.fn<(sessionId: string) => string>();
    getToken.mockReturnValueOnce("tok1").mockReturnValueOnce("tok2");

    const mock = createFetchMock((call) => {
      if (/\/scribe_sessions\/[^/]+$/.test(call.url) && call.method === "GET") {
        if (call.bearer === "tok1") return resp({ error: "expired" }, 401);
        return resp({ id: "sess_6", status: "completed", outputs: [{ id: "o1", type: "transcript", status: "completed", result: { text: "ok" } }] }, 200);
      }
      return resp({ error: "unexpected" }, 500);
    });

    const client = createScribeClient({ baseUrl: BASE, getToken, fetch: mock.fn });
    const result = await client.session("sess_6").result({ pollIntervalMs: 1 });

    expect(result.status).toBe("completed");
    expect(getToken).toHaveBeenCalledTimes(2);
    const gets = mock.matching("/scribe_sessions/sess_6", "GET");
    expect(gets).toHaveLength(2);
    expect(gets[0]!.bearer).toBe("tok1");
    expect(gets[1]!.bearer).toBe("tok2");
  });
});
