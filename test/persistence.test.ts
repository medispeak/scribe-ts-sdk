// Installs a global `indexedDB` (used only by case (g), the real-store test).
import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScribeClient, listUnfinishedSessions } from "../src/index";
import { SessionHttp } from "../src/http";
import {
  IndexedDbChunkStore,
  MemoryChunkStore,
  resetChunkStore,
} from "../src/persistence";
import { Session } from "../src/session";
import {
  audioBlob,
  createFetchMock,
  formField,
  installMemoryChunkStore,
  installMockRecorder,
  resp,
  type RecordedCall,
} from "./mocks";

const BASE = "https://api.example.test/api/v2";
const TOKEN = "mss_session_token";

function statusEmpty(): Response {
  return resp({ received_seqs: [], final_seen: false, bytes: 0 }, 200);
}

/**
 * A Session constructed with uploadAttempts=1 so the failure path takes exactly
 * one POST per seq and never sleeps — keeping these tests deterministic + fast.
 * The store is the injected MemoryChunkStore (via getChunkStore()).
 */
function fastSession(id: string, fetchFn: typeof fetch): Session {
  const http = new SessionHttp(BASE, id, () => TOKEN, fetchFn);
  return new Session(id, http, { uploadAttempts: 1 });
}

let store: MemoryChunkStore;

beforeEach(() => {
  store = installMemoryChunkStore();
  // jsdom has no URL.createObjectURL; stub it so localRecording() can run.
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL =
    () => "blob:mock";
});

afterEach(() => {
  resetChunkStore();
  vi.useRealTimers();
});

describe("persistence: durable capture (MemoryChunkStore)", () => {
  it("(a) persists a captured chunk to the store before it is acked", async () => {
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) return statusEmpty();
      // Never ack, so we can observe the persisted-but-pending chunk.
      if (call.url.endsWith("/audio/chunks")) return resp({ error: "net" }, 500);
      return resp({ error: "unexpected" }, 500);
    });

    const recorder = installMockRecorder();
    const session = fastSession("sess", mock.fn);

    await session.record();
    recorder.emit(audioBlob("a"));

    const all = await store.getAll("sess");
    expect(all.map((c) => c.seq)).toEqual([0]);
    const pending = await store.getPending("sess");
    expect(pending.map((c) => c.seq)).toEqual([0]);
  });

  it("(b) keeps chunks and enters `interrupted` on a hard upload/commit failure", async () => {
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) return statusEmpty();
      if (call.url.endsWith("/audio/chunks")) return resp({ error: "net" }, 500);
      if (call.url.endsWith("/commit")) return resp({ error: "down" }, 500);
      return resp({ error: "unexpected" }, 500);
    });

    const recorder = installMockRecorder();
    const session = fastSession("sess", mock.fn);

    await session.record();
    recorder.emit(audioBlob("a"));

    await expect(session.stop()).rejects.toThrow();

    const pending = await store.getPending("sess");
    expect(pending.map((c) => c.seq)).toContain(0); // chunk not lost
    expect(session.status).toBe("interrupted");
  });

  it("(c) retry() re-sends pending chunks and commits, moving to processing", async () => {
    const state = { fail: true };
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) return statusEmpty();
      if (call.url.endsWith("/audio/chunks")) {
        return state.fail ? resp({ error: "net" }, 500) : resp({ received: 0 }, 200);
      }
      if (call.url.endsWith("/commit")) {
        return state.fail ? resp({ error: "down" }, 500) : resp({}, 202);
      }
      return resp({ error: "unexpected" }, 500);
    });

    const recorder = installMockRecorder();
    const session = fastSession("sess", mock.fn);

    await session.record();
    recorder.emit(audioBlob("a"));
    await expect(session.stop()).rejects.toThrow();
    expect(session.status).toBe("interrupted");

    // Network recovers → retry reconciles + commits.
    state.fail = false;
    await session.retry();

    expect(mock.matching("/commit", "POST").length).toBeGreaterThanOrEqual(1);
    expect(session.status).toBe("processing");
  });

  it("(d) a resumed session re-hydrates pending seqs and re-sends the final chunk with final=true", async () => {
    const state = { fail: true };
    const chunkPosts: RecordedCall[] = [];
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) return statusEmpty();
      if (call.url.endsWith("/audio/chunks")) {
        if (!state.fail) chunkPosts.push(call);
        return state.fail
          ? resp({ error: "net" }, 500)
          : resp({ received: Number(formField(call.body, "seq")) }, 200);
      }
      if (call.url.endsWith("/commit")) return resp({}, 202);
      return resp({ error: "unexpected" }, 500);
    });

    const recorder = installMockRecorder();
    recorder.setFinalChunk(audioBlob("final"));

    // First session records; uploads fail so chunks persist (pending), and the
    // trailing chunk is marked final in the store meta.
    const first = fastSession("sess", mock.fn);
    await first.record();
    recorder.emit(audioBlob("a"));
    recorder.emit(audioBlob("b"));
    await expect(first.stop()).rejects.toThrow();
    expect(first.status).toBe("interrupted");
    expect((await store.getPending("sess")).map((c) => c.seq)).toEqual([0, 1, 2]);

    // "Reload": a brand-new client + session over the SAME injected store.
    state.fail = false;
    const client = createScribeClient({
      baseUrl: BASE,
      getToken: () => TOKEN,
      fetch: mock.fn,
    });
    const resumed = (await client.resume("sess")) as Session;
    await resumed.retry();

    // Re-hydrated the pending seqs and re-sent exactly them, final chunk last.
    expect(chunkPosts.map((c) => formField(c.body, "seq"))).toEqual(["0", "1", "2"]);
    const last = chunkPosts[chunkPosts.length - 1]!;
    expect(formField(last.body, "final")).toBe("true");
    expect(formField(last.body, "seq")).toBe("2");
    expect(resumed.status).toBe("processing");
  });

  it("(e) localRecording() concatenates stored chunks in seq order", async () => {
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) return statusEmpty();
      if (call.url.endsWith("/audio/chunks")) return resp({ received: 0 }, 200);
      return resp({ error: "unexpected" }, 500);
    });

    const recorder = installMockRecorder();
    const session = fastSession("sess", mock.fn);

    await session.record();
    recorder.emit(audioBlob("a"));
    recorder.emit(audioBlob("b"));
    recorder.emit(audioBlob("c"));

    await vi.waitFor(async () =>
      expect((await store.getAll("sess")).length).toBe(3),
    );

    const stored = await store.getAll("sess");
    const expectedSize = stored.reduce((n, c) => n + c.blob.size, 0);

    const rec = await session.localRecording();
    expect(rec).toBeDefined();
    expect(rec!.blob.size).toBe(expectedSize);
    expect(typeof rec!.url).toBe("string");
  });

  it("(f) keeps the recording in the store until commit succeeds, then clears it", async () => {
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) return statusEmpty();
      if (call.url.endsWith("/audio/chunks")) {
        return resp({ received: Number(formField(call.body, "seq")) }, 200);
      }
      if (call.url.endsWith("/commit")) return resp({}, 202);
      return resp({ error: "unexpected" }, 500);
    });

    const recorder = installMockRecorder();
    recorder.setFinalChunk(audioBlob("tail"));
    const session = fastSession("sess", mock.fn);

    await session.record();
    recorder.emit(audioBlob("x"));

    // Present right up to a successful commit.
    await vi.waitFor(async () =>
      expect(await listUnfinishedSessions()).toContain("sess"),
    );

    await session.stop();

    expect(await listUnfinishedSessions()).not.toContain("sess");
    expect(await store.getAll("sess")).toEqual([]);
    expect(session.status).toBe("processing");
  });
});

describe("persistence: real IndexedDbChunkStore (fake-indexeddb)", () => {
  it("(g) round-trips put/markAcked/getPending/getAll/listUnfinished/clear", async () => {
    const idb = new IndexedDbChunkStore();

    await idb.put("s", 0, audioBlob("a"));
    await idb.put("s", 1, audioBlob("b"), { final: true });

    const all = await idb.getAll("s");
    expect(all.map((c) => c.seq)).toEqual([0, 1]);
    expect(all[1]!.meta?.final).toBe(true);

    let pending = await idb.getPending("s");
    expect(pending.map((c) => c.seq)).toEqual([0, 1]);

    await idb.markAcked("s", 0);
    pending = await idb.getPending("s");
    expect(pending.map((c) => c.seq)).toEqual([1]);

    await idb.put("s2", 0, audioBlob("z"));
    expect((await idb.listUnfinished()).sort()).toEqual(["s", "s2"]);

    await idb.clear("s");
    expect(await idb.getAll("s")).toEqual([]);
    const unfinished = await idb.listUnfinished();
    expect(unfinished).not.toContain("s");
    expect(unfinished).toContain("s2");
  });
});
