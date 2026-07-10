import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScribeClient } from "../src/index";
import { useScribe } from "../src/react";
import { audioBlob, createFetchMock, installMockRecorder, resp } from "./mocks";

const BASE = "https://api.example.test/api/v2";

function backendMock() {
  return createFetchMock((call) => {
    if (call.url.endsWith("/audio/status")) {
      return resp({ received_seqs: [], final_seen: false, bytes: 0 }, 200);
    }
    if (call.url.endsWith("/audio/chunks")) return resp({ received: 0 }, 200);
    if (call.url.endsWith("/commit")) return resp({}, 202);
    if (/\/scribe_sessions\/[^/]+$/.test(call.url) && call.method === "GET") {
      return resp(
        {
          id: "r1",
          status: "completed",
          outputs: [
            { id: "o1", type: "transcript", status: "completed", result: { text: "hello from react" } },
            { id: "o2", type: "form", status: "completed", result: { severity: "mild" } },
          ],
        },
        200,
      );
    }
    return resp({ error: "unexpected" }, 500);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useScribe", () => {
  it("drives start → stop → result and exposes status + result", async () => {
    const mock = backendMock();
    const recorder = installMockRecorder();
    recorder.setFinalChunk(audioBlob("tail"));
    const client = createScribeClient({ baseUrl: BASE, getToken: () => "tok", fetch: mock.fn });

    const onResult = vi.fn();
    const { result: hook } = renderHook(() =>
      useScribe({ client, sessionId: "r1", onResult }),
    );

    // initial state
    expect(hook.current.status).toBe("idle");
    expect(hook.current.isRecording).toBe(false);
    expect(hook.current.result).toBeNull();

    await act(async () => {
      await hook.current.start();
    });
    expect(hook.current.status).toBe("recording");
    expect(hook.current.isRecording).toBe(true);

    act(() => {
      recorder.emit(audioBlob("mid"));
    });

    await act(async () => {
      await hook.current.stop();
    });

    await waitFor(() => expect(hook.current.status).toBe("completed"));
    expect(hook.current.isRecording).toBe(false);
    expect(hook.current.result?.transcript).toBe("hello from react");
    expect(hook.current.result?.structuredData).toEqual({ severity: "mild" });
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("reflects pause/resume in status flags", async () => {
    const mock = backendMock();
    installMockRecorder();
    const client = createScribeClient({ baseUrl: BASE, getToken: () => "tok", fetch: mock.fn });
    const { result: hook } = renderHook(() => useScribe({ client, sessionId: "r1" }));

    await act(async () => {
      await hook.current.start();
    });
    act(() => hook.current.pause());
    expect(hook.current.status).toBe("paused");
    expect(hook.current.isPaused).toBe(true);

    act(() => hook.current.resume());
    expect(hook.current.status).toBe("recording");
    expect(hook.current.isPaused).toBe(false);
  });

  it("accumulates duration (seconds) while recording", async () => {
    vi.useFakeTimers();
    const mock = backendMock();
    installMockRecorder();
    const client = createScribeClient({ baseUrl: BASE, getToken: () => "tok", fetch: mock.fn });
    const { result: hook } = renderHook(() => useScribe({ client, sessionId: "r1" }));

    await act(async () => {
      await hook.current.start();
    });
    expect(hook.current.duration).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(hook.current.duration).toBe(3);
  });

  it("surfaces errors via error + onError", async () => {
    const mock = createFetchMock((call) => {
      if (call.url.endsWith("/audio/status")) return resp({ received_seqs: [] }, 200);
      return resp({ error: "boom" }, 500); // commit fails
    });
    installMockRecorder();
    const client = createScribeClient({ baseUrl: BASE, getToken: () => "tok", fetch: mock.fn });
    const onError = vi.fn();
    const { result: hook } = renderHook(() =>
      useScribe({ client, sessionId: "r1", onError }),
    );

    await act(async () => {
      await hook.current.start();
    });
    await act(async () => {
      await hook.current.stop();
    });

    expect(hook.current.error).toMatch(/commit failed/);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
