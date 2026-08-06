/**
 * JSON-RPC 2.0 codec over newline-delimited JSON (design C7).
 *
 * Hand-written, no library (OR-10). Framing is NDJSON per STD-7, matching
 * MCP's stdio transport and this repo's existing NDJSON child convention.
 *
 * **The byte cap is enforced on the accumulating buffer, not on a completed
 * line.** That distinction is the whole point: a peer that opens a connection
 * and streams bytes without ever sending a newline would, under an
 * after-the-line check, be buffered without bound — the check would never run.
 * Cutting off at `MAX_LINE_BYTES` while the line is still incomplete bounds a
 * connection's memory regardless of what the peer does.
 *
 * Purity is deliberate and load-bearing (design C7): decoding is
 * `(state, chunk) -> {frames, state}` with no I/O, no socket, and no clock, so
 * every framing edge — a line split across chunks, several lines in one chunk,
 * CRLF, an oversize flood, an embedded-newline attempt — is a plain unit test.
 * `src/runtime/socket-server.ts` (Phase 5) is the only thing that owns a
 * socket; it feeds chunks in and writes encoded lines back out.
 *
 * Responses can never contain a newline: `JSON.stringify` escapes U+000A
 * inside strings, and the encoders below append exactly one terminator. That
 * satisfies MCP's framing invariant without a separate escaping pass.
 */

/** The only JSON-RPC version this daemon speaks. */
export const JSON_RPC_VERSION = "2.0";

/**
 * Hard per-line cap, matching `MAX_PAYLOAD_BYTES` at
 * `packages/state/src/journal/append.ts:22`. NDJSON on its own bounds nothing.
 */
export const MAX_LINE_BYTES = 65_536;

/**
 * JSON-RPC 2.0 reserved codes (STD-8) plus this daemon's two
 * implementation-defined codes from the reserved `-32000…-32099` server range.
 *
 * There is deliberately no `-32002` and no `-32003`: every authentication
 * failure collapses to the single uniform `UNAUTHORIZED`, so a caller cannot
 * distinguish "bad MAC" from "unknown key" from "no such method" (STD-9,
 * CWE-204).
 */
export const ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Uniform authentication failure. Never carries `data`. */
  unauthorized: -32001,
  /** The daemon is shutting down and is no longer accepting work. */
  draining: -32000,
  /** The target request was cancelled by its authenticated owner. */
  requestCancelled: -32002,
  /** A canonical versioned method needs an authenticated negotiation first. */
  protocolNotNegotiated: -32003,
} as const;

/** A JSON-RPC id. Notifications (a missing id) are not supported — see `decodeChunk`. */
export type JsonRpcId = string | number;

export interface JsonRpcRequestFrame {
  readonly kind: "request";
  readonly id: JsonRpcId;
  readonly method: string;
  /** Whatever the caller sent; shape validation belongs to the method handler. */
  readonly params: unknown;
  /**
   * The exact decoded line this frame was parsed from (post CRLF-stripping,
   * pre `JSON.parse`) — the byte span `src/auth/verify.ts`'s canonicaliser
   * re-scans with its own tokenizer to compute the MAC's preimage. Never
   * re-derived from `params`/`method`/`id` by re-serialising: that would
   * open exactly the serialisation-ambiguity gap `src/auth/canonical.ts`'s
   * docblock explains (design C6).
   */
  readonly raw: string;
}

export interface JsonRpcErrorFrame {
  readonly kind: "error";
  /** `null` when the offending line could not be parsed far enough to recover an id. */
  readonly id: JsonRpcId | null;
  readonly code: number;
  readonly message: string;
  /**
   * When true the caller must write this frame and then close the connection.
   * Set only for a cap breach: once the buffer is over-long the stream can no
   * longer be resynchronised, because there is no way to know where the
   * abandoned line was meant to end.
   */
  readonly fatal: boolean;
}

export type Frame = JsonRpcRequestFrame | JsonRpcErrorFrame;

/**
 * Decoder state. Opaque to callers, and carried explicitly rather than held in
 * a closure so a test can construct any mid-stream state directly.
 */
export interface DecoderState {
  /** Bytes received since the last newline. */
  readonly pending: Uint8Array;
  /** Set once a cap breach has poisoned the stream; every later chunk is ignored. */
  readonly poisoned: boolean;
}

export function createDecoderState(): DecoderState {
  return { pending: new Uint8Array(0), poisoned: false };
}

export interface DecodeResult {
  readonly frames: readonly Frame[];
  readonly state: DecoderState;
}

const LF = 0x0a;
const CR = 0x0d;

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function overCap(): JsonRpcErrorFrame {
  return {
    kind: "error",
    id: null,
    code: ERROR_CODES.parse,
    message: "line exceeds the maximum length",
    fatal: true,
  };
}

function invalidRequest(id: JsonRpcId | null, message: string): JsonRpcErrorFrame {
  return { kind: "error", id, code: ERROR_CODES.invalidRequest, message, fatal: false };
}

/** Recovers an id from an otherwise-invalid envelope so the error can be correlated. */
function recoverId(value: Record<string, unknown>): JsonRpcId | null {
  const id = value.id;
  if (typeof id === "string" || (typeof id === "number" && Number.isInteger(id))) {
    return id;
  }
  return null;
}

/**
 * Validates one decoded line against the JSON-RPC 2.0 request envelope
 * (STD-8). Ordered so the most structural failure wins: a line that is not an
 * object cannot yield an id to correlate against, so it reports `null`.
 */
function toFrame(line: string): Frame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      kind: "error",
      id: null,
      code: ERROR_CODES.parse,
      message: "invalid JSON",
      fatal: false,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // Batch requests are arrays; they are not supported, and rejecting them
    // here keeps the rest of the pipeline single-request by construction.
    return invalidRequest(null, "request must be a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  const id = recoverId(record);

  if (record.jsonrpc !== JSON_RPC_VERSION) {
    return invalidRequest(id, `jsonrpc must be "${JSON_RPC_VERSION}"`);
  }
  if (typeof record.method !== "string") {
    return invalidRequest(id, "method must be a string");
  }
  if (id === null) {
    // Notifications would have no response to carry an auth failure, which
    // would make an unauthenticated call silently indistinguishable from an
    // accepted one. Every request must be answerable.
    return invalidRequest(null, "id must be a string or an integer");
  }

  return { kind: "request", id, method: record.method, params: record.params, raw: line };
}

function decodeLine(bytes: Uint8Array): string {
  // Tolerate CRLF: a client writing Windows-style terminators is framing
  // correctly, and the trailing CR is not part of the JSON document.
  const end = bytes.length > 0 && bytes[bytes.length - 1] === CR ? bytes.length - 1 : bytes.length;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * Feeds one chunk through the decoder.
 *
 * A cap breach ends the stream: the returned state is poisoned, the last frame
 * is `fatal`, and any bytes still buffered are dropped. Non-fatal errors —
 * malformed JSON, a bad envelope — do not poison anything, because the newline
 * that terminated them is a reliable resynchronisation point.
 */
export function decodeChunk(state: DecoderState, chunk: Uint8Array): DecodeResult {
  if (state.poisoned) {
    return { frames: [], state };
  }

  let buffer = concat(state.pending, chunk);
  const frames: Frame[] = [];

  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== LF) {
      continue;
    }
    const line = buffer.subarray(start, i);
    if (line.length > MAX_LINE_BYTES) {
      frames.push(overCap());
      return { frames, state: { pending: new Uint8Array(0), poisoned: true } };
    }
    // A blank line is a keep-alive, not a request; skip it rather than
    // answering a parse error the peer did not earn.
    const text = decodeLine(line);
    if (text.trim().length > 0) {
      frames.push(toFrame(text));
    }
    start = i + 1;
  }

  buffer = buffer.subarray(start);

  // The cap applies to the *incomplete* tail too — this is the check that
  // stops an unterminated flood.
  if (buffer.length > MAX_LINE_BYTES) {
    frames.push(overCap());
    return { frames, state: { pending: new Uint8Array(0), poisoned: true } };
  }

  return { frames, state: { pending: buffer, poisoned: false } };
}

/**
 * `createCodec()` — the pure `(chunk: Uint8Array) => Frame[]` transform
 * (plan Task 3 Step 1/Step 5). `decodeChunk`/`DecoderState` above are the
 * actual engine, threading state explicitly so a test can construct any
 * mid-stream state directly; this is a thin closure over that engine for
 * the one caller (the future `src/runtime/socket-server.ts`, Phase 5) that
 * wants one codec instance per accepted connection rather than carrying the
 * state itself.
 */
export function createCodec(): (chunk: Uint8Array) => Frame[] {
  let state = createDecoderState();
  return (chunk: Uint8Array): Frame[] => {
    const result = decodeChunk(state, chunk);
    state = result.state;
    return [...result.frames];
  };
}

/** Encodes a successful response as one NDJSON line, terminator included. */
export function encodeResult(id: JsonRpcId, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, result })}\n`;
}

/**
 * Encodes an error response as one NDJSON line. There is no `data` parameter
 * by design: `unauthorized` responses must be byte-identical across every
 * cause, and an optional `data` field is exactly how that invariant erodes.
 */
export function encodeError(id: JsonRpcId | null, code: number, message: string): string {
  return `${JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, error: { code, message } })}\n`;
}
