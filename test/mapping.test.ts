import { describe, expect, it } from "vitest";

import { mapSessionBody, type WireSessionBody } from "../src/mapping";

describe("mapSessionBody — live transcript", () => {
  it("reads the top-level transcript (the live field) while recording, when the output is still empty", () => {
    const body: WireSessionBody = {
      id: "s1",
      status: "uploading",
      transcript: { text: "patient has a headache", language: "en" },
      outputs: [{ id: "o1", type: "transcript", status: "pending", result: {} }],
    };
    expect(mapSessionBody(body).transcript).toBe("patient has a headache");
  });

  it("prefers the top-level transcript over the output at commit", () => {
    const body: WireSessionBody = {
      id: "s1",
      status: "completed",
      transcript: { text: "final live text", language: "en" },
      outputs: [
        { id: "o1", type: "transcript", status: "success", result: { text: "output text" } },
      ],
    };
    expect(mapSessionBody(body).transcript).toBe("final live text");
  });

  it("falls back to the output transcript for older backends without the top-level field", () => {
    const body: WireSessionBody = {
      id: "s1",
      status: "completed",
      outputs: [
        { id: "o1", type: "transcript", status: "success", result: { text: "output only" } },
      ],
    };
    expect(mapSessionBody(body).transcript).toBe("output only");
  });
});
