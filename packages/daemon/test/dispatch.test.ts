/**
 * `dispatchFrame` — envelope validation → `daemon.hello` → drain check →
 * authenticate → registry lookup → handler (design C8, plan Task 3 Step 6).
 *
 * `dispatchFrame` returns the exact NDJSON wire line, so every assertion
 * below either parses that line back with `JSON.parse` or compares two
 * lines directly — the same thing a real client on the other end of the
 * socket would do.
 */

import { describe, expect, it, vi } from "vitest";
import { mintConnectionAuthState } from "../src/auth/challenge.js";
import type { AuthenticatedCredential } from "../src/auth/verify.js";
import { buildAuthMacMessage, bytesToHex } from "../src/auth/verify.js";
import type { JsonRpcErrorFrame, JsonRpcId, JsonRpcRequestFrame } from "../src/rpc/codec.js";
import type { DispatchDeps } from "../src/rpc/dispatch.js";
import { dispatchFrame } from "../src/rpc/dispatch.js";
import { DAEMON_HELLO_METHOD, DAEMON_STATUS_METHOD, createMethodRegistry } from "../src/rpc/methods.js";
import type { MacProvider, RandomSource } from "../src/ports.js";

function counterRandomSource(): RandomSource {
  let counter = 0;
  return {
    bytes: (length: number) =>
      Uint8Array.from({ length }, () => {
        counter += 1;
        return counter & 0xff;
      }),
  };
}

function fakeMacProvider(): MacProvider {
  return {
    hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
      const digest = new Uint8Array(32);
      let seed = 7;
      for (const byte of key) {
        seed = (seed * 31 + byte) & 0xff;
      }
      for (let index = 0; index < message.length; index++) {
        const slot = index % 32;
        digest[slot] = ((digest[slot] ?? 0) ^ ((message[index] ?? 0) + seed + index)) & 0xff;
      }
      return digest;
    },
    constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
      if (a.length !== b.length) {
        return false;
      }
      let diff = 0;
      for (let index = 0; index < a.length; index++) {
        diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
      }
      return diff === 0;
    },
  };
}

const KEY_ID = "aaaabbbbccccdddd";
const SECRET = Uint8Array.from({ length: 32 }, (_v, i) => i + 1);

function credential(): AuthenticatedCredential {
  return { keyId: KEY_ID, secret: SECRET };
}

function requestFrame(id: JsonRpcId, method: string, raw: string, params: unknown = {}): JsonRpcRequestFrame {
  return { kind: "request", id, method, params, raw };
}

function baseDeps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    registry: createMethodRegistry([[DAEMON_STATUS_METHOD, () => ({ ok: true })]]),
    credential: credential(),
    macProvider: fakeMacProvider(),
    instanceId: "instance-1",
    protocolVersion: 1,
    isDraining: () => false,
    ...overrides,
  };
}

/** Signs a `{"jsonrpc":"2.0","id":<id>,"method":<method>,"params":{}}` frame. */
function signedFrame(
  deps: DispatchDeps,
  connection: ReturnType<typeof mintConnectionAuthState>,
  id: number,
  method: string,
  sequence: number,
): JsonRpcRequestFrame {
  const canonical = `{"jsonrpc":"2.0","id":${id},"method":"${method}","params":{}}`;
  const mac = bytesToHex(
    deps.macProvider.hmacSha256(
      deps.credential.secret,
      buildAuthMacMessage(connection.challenge, sequence, canonical),
    ),
  );
  const auth = `{"schemaVersion":1,"keyId":"${deps.credential.keyId}","sequence":${sequence},"mac":"${mac}"}`;
  const raw = `{"jsonrpc":"2.0","id":${id},"method":"${method}","params":{"auth":${auth}}}`;
  return requestFrame(id, method, raw);
}

function parseLine(line: string): { id: JsonRpcId; result?: unknown; error?: { code: number; message: string } } {
  return JSON.parse(line.trimEnd());
}

describe("dispatchFrame — daemon.hello", () => {
  it("succeeds pre-auth and returns a well-formed DaemonHelloResult/v1 shape", async () => {
    const deps = baseDeps();
    const connection = mintConnectionAuthState(counterRandomSource());
    const line = await dispatchFrame(deps, connection, requestFrame(1, DAEMON_HELLO_METHOD, "irrelevant"));

    expect(line.endsWith("\n")).toBe(true);
    const parsed = parseLine(line);
    expect(parsed.error).toBeUndefined();
    const result = parsed.result as Record<string, unknown>;
    expect(result.schemaVersion).toBe(1);
    expect(result.protocolVersion).toBe(1);
    expect(result.instanceId).toBe("instance-1");
    expect(result.macAlgorithm).toBe("hmac-sha256");
    expect(result.keyId).toBe(KEY_ID);
    expect(result.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(connection.helloCalled).toBe(true);
  });

  it("rejects a second daemon.hello on the same connection with -32600, without re-minting or resetting state", async () => {
    const deps = baseDeps();
    const connection = mintConnectionAuthState(counterRandomSource());
    await dispatchFrame(deps, connection, requestFrame(1, DAEMON_HELLO_METHOD, "x"));

    const authenticated = signedFrame(deps, connection, 2, DAEMON_STATUS_METHOD, 5);
    const okLine = await dispatchFrame(deps, connection, authenticated);
    expect(parseLine(okLine).error).toBeUndefined();
    expect(connection.lastSequence).toBe(5);

    const secondHelloLine = await dispatchFrame(deps, connection, requestFrame(3, DAEMON_HELLO_METHOD, "y"));
    expect(parseLine(secondHelloLine).error?.code).toBe(-32600);
    // Untouched: helloCalled stays true, lastSequence stays 5.
    expect(connection.lastSequence).toBe(5);

    // The sequence-5 request cannot be replayed after the rejected re-hello.
    const replayLine = await dispatchFrame(deps, connection, authenticated);
    expect(parseLine(replayLine).error?.code).toBe(-32001);
  });
});

describe("dispatchFrame — no method-existence oracle", () => {
  it("unauthenticated daemon.status and an unauthenticated fabricated method produce byte-identical wire lines", async () => {
    const deps = baseDeps();
    const connection1 = mintConnectionAuthState(counterRandomSource());
    const connection2 = mintConnectionAuthState(counterRandomSource());

    const realLine = await dispatchFrame(
      deps,
      connection1,
      requestFrame(1, DAEMON_STATUS_METHOD, '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}'),
    );
    const fabricatedLine = await dispatchFrame(
      deps,
      connection2,
      requestFrame(
        1,
        "daemon.notARealMethod",
        '{"jsonrpc":"2.0","id":1,"method":"daemon.notARealMethod","params":{}}',
      ),
    );

    expect(realLine).toBe(fabricatedLine);
    expect(realLine).toContain('"code":-32001');
    expect(realLine).not.toContain('"data"');
  });
});

describe("dispatchFrame — authenticated dispatch", () => {
  it("routes an authenticated request to its registered handler", async () => {
    const deps = baseDeps({
      registry: createMethodRegistry([[DAEMON_STATUS_METHOD, () => ({ lifecycleState: "serving" })]]),
    });
    const connection = mintConnectionAuthState(counterRandomSource());
    const frame = signedFrame(deps, connection, 1, DAEMON_STATUS_METHOD, 1);

    const line = await dispatchFrame(deps, connection, frame);
    const parsed = parseLine(line);
    expect(parsed.error).toBeUndefined();
    expect(parsed.result).toEqual({ lifecycleState: "serving" });
  });

  it("returns -32601 for an authenticated but unregistered method", async () => {
    const deps = baseDeps();
    const connection = mintConnectionAuthState(counterRandomSource());
    const frame = signedFrame(deps, connection, 1, "daemon.notARealMethod", 1);

    const line = await dispatchFrame(deps, connection, frame);
    expect(parseLine(line).error?.code).toBe(-32601);
  });

  it("a handler throw yields a bare -32603 and reports the full error via onHandlerError, not on the wire", async () => {
    const handlerError = new Error("boom, includes /secret/path and a stack trace");
    const onHandlerError = vi.fn();
    const deps = baseDeps({
      registry: createMethodRegistry([
        [
          DAEMON_STATUS_METHOD,
          () => {
            throw handlerError;
          },
        ],
      ]),
      onHandlerError,
    });
    const connection = mintConnectionAuthState(counterRandomSource());
    const frame = signedFrame(deps, connection, 1, DAEMON_STATUS_METHOD, 1);

    const line = await dispatchFrame(deps, connection, frame);
    const errorBody = parseLine(line).error;
    expect(errorBody?.code).toBe(-32603);
    expect(errorBody?.message).not.toContain("/secret/path");
    expect(onHandlerError).toHaveBeenCalledWith(DAEMON_STATUS_METHOD, handlerError);
  });
});

describe("dispatchFrame — draining", () => {
  it("still answers daemon.hello normally while draining", async () => {
    const deps = baseDeps({ isDraining: () => true });
    const connection = mintConnectionAuthState(counterRandomSource());
    const line = await dispatchFrame(deps, connection, requestFrame(1, DAEMON_HELLO_METHOD, "x"));
    expect(parseLine(line).error).toBeUndefined();
  });

  it("rejects daemon.status with -32000 draining while draining", async () => {
    const deps = baseDeps({ isDraining: () => true });
    const connection = mintConnectionAuthState(counterRandomSource());
    const frame = signedFrame({ ...deps, isDraining: () => false }, connection, 1, DAEMON_STATUS_METHOD, 1);
    const line = await dispatchFrame(deps, connection, frame);
    expect(parseLine(line).error).toEqual({ code: -32000, message: "draining" });
  });
});

describe("dispatchFrame — codec-level error frames pass through unchanged", () => {
  it("relays an error Frame's code, message, and id verbatim", async () => {
    const deps = baseDeps();
    const connection = mintConnectionAuthState(counterRandomSource());
    const errorFrame: JsonRpcErrorFrame = { kind: "error", id: 5, code: -32700, message: "parse error", fatal: false };

    const line = await dispatchFrame(deps, connection, errorFrame);
    expect(JSON.parse(line.trimEnd())).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: { code: -32700, message: "parse error" },
    });
  });
});
