/**
 * `createCodec()` — the NDJSON JSON-RPC 2.0 framing transform (design C7,
 * plan Task 3 Step 1).
 */

import { describe, expect, it } from "vitest";
import {
  createCodec,
  type ErrorFrame,
  encodeResponseLine,
  type Frame,
  MAX_LINE_BYTES,
  type RequestFrame,
} from "../src/rpc/codec.js";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function requestLine(id: number, method: string, params: unknown = {}): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

describe("createCodec — framing", () => {
  it("parses one complete line delivered in one chunk", () => {
    const codec = createCodec();
    const frames = codec(bytes(requestLine(1, "daemon.status")));
    expect(frames).toHaveLength(1);
    const frame = frames[0] as RequestFrame;
    expect(frame.kind).toBe("request");
    expect(frame.id).toBe(1);
    expect(frame.method).toBe("daemon.status");
  });

  it("produces no frame until a line is terminated, across multiple chunks", () => {
    const codec = createCodec();
    const line = requestLine(2, "daemon.status");
    const splitPoint = Math.floor(line.length / 2);
    const first = codec(bytes(line.slice(0, splitPoint)));
    expect(first).toHaveLength(0);
    const second = codec(bytes(line.slice(splitPoint)));
    expect(second).toHaveLength(1);
    expect((second[0] as RequestFrame).id).toBe(2);
  });

  it("emits several frames from several lines delivered in one chunk", () => {
    const codec = createCodec();
    const chunk = requestLine(1, "daemon.status") + requestLine(2, "daemon.recovery");
    const frames = codec(bytes(chunk));
    expect(frames).toHaveLength(2);
    expect((frames[0] as RequestFrame).method).toBe("daemon.status");
    expect((frames[1] as RequestFrame).method).toBe("daemon.recovery");
  });

  it("accepts CRLF line endings, stripping the trailing CR from the raw line", () => {
    const codec = createCodec();
    const withoutLf = requestLine(1, "daemon.status").slice(0, -1);
    const frames = codec(bytes(`${withoutLf}\r\n`));
    expect(frames).toHaveLength(1);
    const frame = frames[0] as RequestFrame;
    expect(frame.kind).toBe("request");
    expect(frame.raw.endsWith("\r")).toBe(false);
  });

  it("a line at exactly the 64 KiB cap is accepted", () => {
    const codec = createCodec();
    const overhead = requestLine(1, "daemon.status", { pad: "" }).length - 1; // sans trailing LF
    const padLength = MAX_LINE_BYTES - overhead;
    const line = requestLine(1, "daemon.status", { pad: "x".repeat(padLength) });
    expect(line.length - 1).toBe(MAX_LINE_BYTES);
    const frames = codec(bytes(line));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe("request");
  });

  it("a line one byte over the 64 KiB cap is answered -32700 and the connection closes", () => {
    const codec = createCodec();
    const overhead = requestLine(1, "daemon.status", { pad: "" }).length - 1;
    const padLength = MAX_LINE_BYTES - overhead + 1;
    const line = requestLine(1, "daemon.status", { pad: "x".repeat(padLength) });
    expect(line.length - 1).toBe(MAX_LINE_BYTES + 1);

    const frames = codec(bytes(line));
    expect(frames).toHaveLength(1);
    const frame = frames[0] as ErrorFrame;
    expect(frame.kind).toBe("error");
    expect(frame.code).toBe(-32700);
    expect(frame.fatal).toBe(true);
    expect(frame.message).not.toContain(line);

    // The connection is closed: further chunks (even well-formed ones) are discarded.
    const after = codec(bytes(requestLine(2, "daemon.status")));
    expect(after).toHaveLength(0);
  });

  it("an unterminated flood over the cap, delivered without any newline, is cut off before it is fully buffered", () => {
    const codec = createCodec();
    const flood = "x".repeat(MAX_LINE_BYTES + 10);
    const frames = codec(bytes(flood));
    expect(frames).toHaveLength(1);
    const frame = frames[0] as ErrorFrame;
    expect(frame.code).toBe(-32700);
    expect(frame.fatal).toBe(true);

    // The codec is now closed — proof the flood was never retained waiting for a terminator.
    const after = codec(bytes(`\n${requestLine(3, "daemon.status")}`));
    expect(after).toHaveLength(0);
  });

  it("a flood arriving across several small chunks is still cut off at the cap", () => {
    const codec = createCodec();
    const chunkSize = 4096;
    const chunk = "x".repeat(chunkSize);
    let frames: Frame[] = [];
    for (let sent = 0; sent <= MAX_LINE_BYTES + chunkSize; sent += chunkSize) {
      frames = codec(bytes(chunk));
      if (frames.length > 0) {
        break;
      }
    }
    expect(frames).toHaveLength(1);
    expect((frames[0] as ErrorFrame).code).toBe(-32700);
    expect((frames[0] as ErrorFrame).fatal).toBe(true);
  });

  it("invalid JSON on a line yields -32700, not fatal", () => {
    const codec = createCodec();
    const frames = codec(bytes("{not valid json\n"));
    expect(frames).toHaveLength(1);
    const frame = frames[0] as ErrorFrame;
    expect(frame.code).toBe(-32700);
    expect(frame.fatal).toBe(false);
    expect(frame.message).not.toContain("{not valid json");
  });

  it.each([
    ["missing jsonrpc", { id: 1, method: "daemon.status" }],
    ["wrong jsonrpc version", { jsonrpc: "1.0", id: 1, method: "daemon.status" }],
    ["missing method", { jsonrpc: "2.0", id: 1 }],
    ["non-string method", { jsonrpc: "2.0", id: 1, method: 42 }],
    ["missing id", { jsonrpc: "2.0", method: "daemon.status" }],
    ["array instead of object", [1, 2, 3]],
  ])("a well-formed JSON line that violates the envelope (%s) yields -32600", (_label, payload) => {
    const codec = createCodec();
    const frames = codec(bytes(`${JSON.stringify(payload)}\n`));
    expect(frames).toHaveLength(1);
    const frame = frames[0] as ErrorFrame;
    expect(frame.code).toBe(-32600);
    expect(frame.fatal).toBe(false);
  });

  it("an embedded raw newline inside a would-be string does not corrupt subsequent framing", () => {
    const codec = createCodec();
    // The framer is newline-blind by construction (OR-10): a raw LF always
    // ends the current line, even one an attacker placed inside what looks
    // like a JSON string. The truncated first half fails to parse; the
    // second half, and any further well-formed line, are still framed
    // correctly.
    const attack = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.st` + `\natus" })}\n`;
    const good = requestLine(9, "daemon.status");
    const frames = codec(bytes(attack + good));
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const last = frames.at(-1) as RequestFrame;
    expect(last.kind).toBe("request");
    expect(last.id).toBe(9);
  });

  it("once closed by an oversize cutoff, no more frames are ever produced", () => {
    const codec = createCodec();
    codec(bytes("x".repeat(MAX_LINE_BYTES + 1)));
    const frames = codec(bytes(requestLine(1, "daemon.status")));
    expect(frames).toHaveLength(0);
  });
});

describe("encodeResponseLine", () => {
  it("produces compact JSON terminated by exactly one newline", () => {
    const line = encodeResponseLine({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    expect(line).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
  });

  it("escapes an embedded newline in response data rather than emitting a raw one", () => {
    const line = encodeResponseLine({
      jsonrpc: "2.0",
      id: 1,
      result: { note: "line one\nline two" },
    });
    // Exactly one raw newline in the whole line: the trailing terminator.
    expect(line.split("\n")).toHaveLength(2);
    expect(line.at(-1)).toBe("");
    expect(line).toContain("\\n");
  });
});
