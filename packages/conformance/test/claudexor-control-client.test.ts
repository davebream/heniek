import { describe, expect, it } from "vitest";
import { createControlClient, parseSseFrame } from "../src/smoke/claudexor/control-client.js";

describe("parseSseFrame", () => {
  it("parses an id/event/data frame", () => {
    const frame = parseSseFrame('id: 7\nevent: run.created\ndata: {"seq":7,"type":"run.created"}');
    if (frame === null) throw new Error("expected a parsed frame");
    expect(frame.id).toBe("7");
    expect(frame.event).toBe("run.created");
    expect((frame.data as { seq: number }).seq).toBe(7);
  });

  it("ignores comment-only keepalive frames", () => {
    expect(parseSseFrame(": connected")).toBeNull();
  });

  it("survives a malformed data payload without throwing", () => {
    expect(parseSseFrame("id: 1\ndata: {not json")?.data).toBeNull();
  });
});

async function captureBody(fn: () => Promise<void>): Promise<unknown> {
  let captured: unknown = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return captured;
}

describe("interaction answer request shape", () => {
  // Regression: the body is a LIST of per-question answers, not a single
  // string, and the questionId comes from the interaction.requested EVENT
  // payload rather than the run summary. Getting either wrong leaves the
  // interaction unanswerable, and the canary then reports "same-session resume
  // unsupported" for a capability that works.
  it("sends answers as a list of questionId/selectedLabels/freeText", async () => {
    const client = createControlClient({ baseUrl: "http://127.0.0.1:1", token: "t" });
    const body = await captureBody(() =>
      client.answer("run-1", "int-1", [{ questionId: "q-1", freeText: "JSON" }]),
    );
    expect(body).toEqual({
      answers: [{ questionId: "q-1", selectedLabels: [], freeText: "JSON" }],
    });
  });

  it("answers every question in a multi-question interaction", async () => {
    const client = createControlClient({ baseUrl: "http://127.0.0.1:1", token: "t" });
    const body = await captureBody(() =>
      client.answer("run-1", "int-1", [
        { questionId: "q-1", selectedLabels: ["yes"] },
        { questionId: "q-2", freeText: "YAML" },
      ]),
    );
    expect((body as { answers: unknown[] }).answers).toHaveLength(2);
  });
});

describe("cancel request shape", () => {
  // Regression: `control` is an OBJECT ({kind: "cancel"}), not a bare verb
  // string. Sending the string is rejected as invalid_request, and the
  // cancellation canary then reports a false "unsupported" — an engine
  // limitation that does not exist.
  it("sends control as an object with kind: cancel", async () => {
    let captured: unknown = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await createControlClient({ baseUrl: "http://127.0.0.1:1", token: "t" }).cancel("run-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(captured).toEqual({ control: { kind: "cancel", reason: "heniek q003 canary" } });
  });
});
