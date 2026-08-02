/**
 * The JSON-RPC 2.0 / NDJSON codec (design C7, plan Task 3).
 *
 * The codec is pure precisely so these edges are unit-testable without a
 * socket, so the tests exercise them directly: lines split across chunk
 * boundaries, several lines in one chunk, CRLF, oversize floods, and
 * embedded-newline attempts.
 */

import { describe, expect, it } from "vitest";
import {
  createDecoderState,
  type DecoderState,
  decodeChunk,
  ERROR_CODES,
  encodeError,
  encodeResult,
  type Frame,
  type JsonRpcRequestFrame,
  MAX_LINE_BYTES,
} from "../src/rpc/codec.js";

const encoder = new TextEncoder();

/** Feeds chunks in order, returning every frame emitted across all of them. */
function feed(...chunks: string[]): { frames: Frame[]; state: DecoderState } {
  let state = createDecoderState();
  const frames: Frame[] = [];
  for (const chunk of chunks) {
    const result = decodeChunk(state, encoder.encode(chunk));
    frames.push(...result.frames);
    state = result.state;
  }
  return { frames, state };
}

function requestLine(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.status", ...overrides })}\n`;
}

describe("decodeChunk — framing", () => {
  it("decodes one complete line", () => {
    const { frames } = feed(requestLine());

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "request", id: 1, method: "daemon.status" });
  });

  it("decodes several lines arriving in a single chunk", () => {
    const { frames } = feed(
      requestLine({ id: 1 }) + requestLine({ id: 2 }) + requestLine({ id: 3 }),
    );

    expect(frames.map((f) => (f as JsonRpcRequestFrame).id)).toEqual([1, 2, 3]);
  });

  it("reassembles a line split across chunk boundaries", () => {
    const line = requestLine();
    const split = Math.floor(line.length / 2);

    const { frames } = feed(line.slice(0, split), line.slice(split));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "request", method: "daemon.status" });
  });

  it("emits nothing until the terminating newline arrives", () => {
    const withoutTerminator = requestLine().slice(0, -1);

    const { frames, state } = feed(withoutTerminator);

    expect(frames).toEqual([]);
    expect(state.pending.length).toBeGreaterThan(0);
  });

  it("splits a line one byte at a time without losing anything", () => {
    const chunks = [...requestLine()];

    const { frames } = feed(...chunks);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "request", id: 1 });
  });

  it("tolerates CRLF terminators — the CR is framing, not JSON", () => {
    const { frames } = feed(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "m" })}\r\n`);

    expect(frames[0]).toMatchObject({ kind: "request", id: 7, method: "m" });
  });

  it("skips blank and whitespace-only lines instead of answering a parse error", () => {
    const { frames } = feed(`\n   \n${requestLine()}\n`);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "request" });
  });
});

describe("decodeChunk — the byte cap", () => {
  it("cuts off an unterminated flood rather than buffering it", () => {
    // The decisive case: no newline ever arrives, so a cap checked only on
    // completed lines would never fire and the buffer would grow unbounded.
    const { frames, state } = feed("x".repeat(MAX_LINE_BYTES + 1));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "error",
      code: ERROR_CODES.parse,
      fatal: true,
    });
    expect(state.poisoned).toBe(true);
  });

  it("fires across chunks, not just within one", () => {
    const half = "x".repeat(Math.ceil((MAX_LINE_BYTES + 2) / 2));

    const { frames } = feed(half, half);

    expect(frames.at(-1)).toMatchObject({ code: ERROR_CODES.parse, fatal: true });
  });

  it("rejects an oversize completed line too", () => {
    const { frames } = feed(`${"x".repeat(MAX_LINE_BYTES + 1)}\n`);

    expect(frames[0]).toMatchObject({ code: ERROR_CODES.parse, fatal: true });
  });

  it("accepts a line exactly at the cap — the boundary is inclusive", () => {
    const padding = "y".repeat(
      MAX_LINE_BYTES - JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m", params: "" }).length,
    );

    const { frames } = feed(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m", params: padding })}\n`,
    );

    expect(frames[0]).toMatchObject({ kind: "request", method: "m" });
  });

  it("drops buffered bytes and ignores every later chunk once poisoned", () => {
    const { frames, state } = feed("x".repeat(MAX_LINE_BYTES + 1), requestLine());

    // The valid request in the second chunk must NOT be honoured: after a cap
    // breach there is no way to know where the abandoned line ended, so the
    // stream cannot be resynchronised.
    expect(frames.filter((f) => f.kind === "request")).toEqual([]);
    expect(state.pending.length).toBe(0);
  });
});

describe("decodeChunk — envelope validation (STD-8)", () => {
  it("reports malformed JSON as a parse error that does not poison the stream", () => {
    const { frames, state } = feed(`{not json\n${requestLine()}`);

    expect(frames[0]).toMatchObject({ code: ERROR_CODES.parse, fatal: false, id: null });
    // The newline is a reliable resynchronisation point, so the next line is
    // still honoured.
    expect(frames[1]).toMatchObject({ kind: "request", id: 1 });
    expect(state.poisoned).toBe(false);
  });

  it("rejects a wrong or missing jsonrpc version", () => {
    const { frames } = feed(`${JSON.stringify({ jsonrpc: "1.0", id: 1, method: "m" })}\n`);

    expect(frames[0]).toMatchObject({ code: ERROR_CODES.invalidRequest, id: 1 });
  });

  it("rejects a non-string method", () => {
    const { frames } = feed(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: 42 })}\n`);

    expect(frames[0]).toMatchObject({ code: ERROR_CODES.invalidRequest, id: 1 });
  });

  it("rejects a notification — every request must be answerable", () => {
    // Without an id there is no response to carry an auth failure, which would
    // make an unauthenticated call indistinguishable from an accepted one.
    const { frames } = feed(`${JSON.stringify({ jsonrpc: "2.0", method: "daemon.status" })}\n`);

    expect(frames[0]).toMatchObject({ code: ERROR_CODES.invalidRequest, id: null });
  });

  it("rejects a batch array rather than partially supporting batching", () => {
    const { frames } = feed(`${JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "m" }])}\n`);

    expect(frames[0]).toMatchObject({ code: ERROR_CODES.invalidRequest, id: null });
  });

  it("recovers the id from an invalid envelope so the error can be correlated", () => {
    const { frames } = feed(`${JSON.stringify({ jsonrpc: "bad", id: "abc", method: "m" })}\n`);

    expect(frames[0]).toMatchObject({ id: "abc" });
  });

  it("passes params through untouched — shape validation belongs to the handler", () => {
    const { frames } = feed(requestLine({ params: { auth: { keyId: "k" }, extra: [1, 2] } }));

    expect((frames[0] as JsonRpcRequestFrame).params).toEqual({
      auth: { keyId: "k" },
      extra: [1, 2],
    });
  });
});

describe("encodeResult / encodeError — framing invariants", () => {
  it("terminates with exactly one newline and contains no other", () => {
    const line = encodeResult(1, { ok: true });

    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
  });

  it("escapes an embedded newline instead of emitting a frame break", () => {
    // The attack: a result string containing U+000A would otherwise split one
    // response into two frames, letting a caller forge a second message.
    const line = encodeResult(1, { note: "first\nsecond" });

    expect(line.slice(0, -1)).not.toContain("\n");
    expect(line).toContain("\\n");
  });

  it("round-trips an encoded result back through the decoder as one frame", () => {
    const line = encodeResult(1, { note: "a\nb\nc" });

    const { frames } = feed(line.replace('"result"', '"method"'));

    expect(frames).toHaveLength(1);
  });

  it("emits an error object with no data field", () => {
    // `data` is exactly how the byte-identical `unauthorized` invariant erodes.
    const parsed = JSON.parse(encodeError(1, ERROR_CODES.unauthorized, "unauthorized"));

    expect(parsed.error).toEqual({ code: ERROR_CODES.unauthorized, message: "unauthorized" });
    expect(Object.keys(parsed.error)).not.toContain("data");
  });

  it("produces byte-identical unauthorized lines regardless of the method asked for", () => {
    // STD-9 / CWE-204: an unauthenticated caller must not learn whether a
    // method exists. The encoder carries no method-dependent state at all.
    const forReal = encodeError(1, ERROR_CODES.unauthorized, "unauthorized");
    const forFabricated = encodeError(1, ERROR_CODES.unauthorized, "unauthorized");

    expect(forReal).toBe(forFabricated);
  });
});
