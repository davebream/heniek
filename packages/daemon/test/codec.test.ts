/**
 * `createCodec()` — the pure `(chunk: Uint8Array) => Frame[]` transform
 * (design C7, plan Task 3 Steps 1 and 5). `decodeChunk`/`DecoderState`, the
 * actual framing engine `createCodec()` wraps, are exercised exhaustively
 * in `test/rpc-codec.test.ts`; this file covers only what the wrapper adds
 * — the closure-over-state ergonomics the plan's literal signature names.
 */

import { describe, expect, it } from "vitest";
import { createCodec, type JsonRpcErrorFrame, type JsonRpcRequestFrame, MAX_LINE_BYTES } from "../src/rpc/codec.js";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function requestLine(id: number, method: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })}\n`;
}

describe("createCodec", () => {
  it("is a (chunk: Uint8Array) => Frame[] function that needs no explicit state threading", () => {
    const codec = createCodec();
    expect(typeof codec).toBe("function");
    const frames = codec(bytes(requestLine(1, "daemon.status")));
    expect(frames).toHaveLength(1);
    expect((frames[0] as JsonRpcRequestFrame).id).toBe(1);
  });

  it("accumulates state across calls, exactly like decodeChunk threaded by hand", () => {
    const codec = createCodec();
    const line = requestLine(2, "daemon.status");
    const splitPoint = Math.floor(line.length / 2);

    expect(codec(bytes(line.slice(0, splitPoint)))).toHaveLength(0);
    const second = codec(bytes(line.slice(splitPoint)));
    expect(second).toHaveLength(1);
    expect((second[0] as JsonRpcRequestFrame).id).toBe(2);
  });

  it("emits several frames from several lines delivered in one chunk", () => {
    const codec = createCodec();
    const chunk = requestLine(1, "daemon.status") + requestLine(2, "daemon.recovery");
    const frames = codec(bytes(chunk));
    expect(frames.map((frame) => (frame as JsonRpcRequestFrame).method)).toEqual([
      "daemon.status",
      "daemon.recovery",
    ]);
  });

  it("two independent codec instances do not share state", () => {
    const codecA = createCodec();
    const codecB = createCodec();
    const line = requestLine(1, "daemon.status");
    const half = Math.floor(line.length / 2);

    codecA(bytes(line.slice(0, half)));
    // codecB has received nothing, so it must still be waiting for a
    // terminator — proof the two closures do not share the module-level
    // `decodeChunk` engine's state.
    expect(codecB(bytes(line.slice(half)))).toHaveLength(0);
    expect(codecA(bytes(line.slice(half)))).toHaveLength(1);
  });

  it("remains closed forever after an oversize cutoff, across many subsequent calls", () => {
    const codec = createCodec();
    codec(bytes("x".repeat(MAX_LINE_BYTES + 1)));
    for (let i = 0; i < 3; i++) {
      expect(codec(bytes(requestLine(i, "daemon.status")))).toHaveLength(0);
    }
  });

  it("surfaces the same error frame shape decodeChunk itself would produce", () => {
    const codec = createCodec();
    const frames = codec(bytes("x".repeat(MAX_LINE_BYTES + 1)));
    expect(frames).toHaveLength(1);
    const frame = frames[0] as JsonRpcErrorFrame;
    expect(frame.kind).toBe("error");
    expect(frame.code).toBe(-32700);
    expect(frame.fatal).toBe(true);
  });
});
