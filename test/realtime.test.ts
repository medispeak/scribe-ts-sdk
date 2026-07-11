import { describe, it, expect } from "vitest";
import { RealtimeTranscriber } from "../src/realtime";

// The WebRTC connection needs a live browser + mic, so these cover the pure
// event-assembly logic: how OpenAI transcription deltas/completions become the
// growing partial transcript emitted to the caller.
function makeRT(onPartial: (t: string) => void) {
  // http + sessionId are unused on the event path.
  const rt = new RealtimeTranscriber({} as never, "sid", { onPartial });
  return rt as unknown as { onEvent: (data: unknown) => void };
}

const delta = (itemId: string, delta: string) =>
  JSON.stringify({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: itemId,
    delta,
  });

const completed = (itemId: string, transcript: string) =>
  JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: itemId,
    transcript,
  });

describe("RealtimeTranscriber transcript assembly", () => {
  it("accumulates deltas and joins multiple VAD segments in arrival order", () => {
    const seen: string[] = [];
    const rt = makeRT((t) => seen.push(t));
    rt.onEvent(delta("a", "hello"));
    rt.onEvent(delta("a", " there"));
    rt.onEvent(delta("b", "doctor"));
    expect(seen.at(-1)).toBe("hello there doctor");
  });

  it("a completed event replaces that item's accumulated text", () => {
    const seen: string[] = [];
    const rt = makeRT((t) => seen.push(t));
    rt.onEvent(delta("a", "helo"));
    rt.onEvent(completed("a", "hello"));
    expect(seen.at(-1)).toBe("hello");
  });

  it("does not re-emit identical text", () => {
    const seen: string[] = [];
    const rt = makeRT((t) => seen.push(t));
    rt.onEvent(delta("a", "hello"));
    rt.onEvent(completed("a", "hello")); // same resulting text
    expect(seen).toEqual(["hello"]);
  });

  it("ignores non-string, unparseable, and unrelated messages", () => {
    const seen: string[] = [];
    const rt = makeRT((t) => seen.push(t));
    rt.onEvent(123);
    rt.onEvent("not json");
    rt.onEvent(JSON.stringify({ type: "response.done" }));
    expect(seen).toHaveLength(0);
  });
});
