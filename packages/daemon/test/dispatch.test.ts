/**
 * `dispatchFrame` — envelope validation → `daemon.hello` → drain check →
 * authenticate → registry lookup → handler (design C8, plan Task 3 Step 6).
 */

import { describe, expect, it, vi } from "vitest";
import { mintConnectionAuthState } from "../src/auth/challenge.js";
import type { AuthenticatedCredential } from "../src/auth/verify.js";
import { buildAuthMacMessage, bytesToHex } from "../src/auth/verify.js";
import type { MacProvider, RandomSource } from "../src/ports.js";
import type { ErrorFrame, JsonRpcId, RequestFrame } from "../src/rpc/codec.js";
import { encodeResponseLine } from "../src/rpc/codec.js";
import type { DispatchDeps } from "../src/rpc/dispatch.js";
import { dispatchFrame } from "../src/rpc/dispatch.js";
import {
  createMethodRegistry,
  DAEMON_HELLO_METHOD,
  DAEMON_STATUS_METHOD,
} from "../src/rpc/methods.js";

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

function requestFrame(
  id: JsonRpcId,
  method: string,
  raw: string,
  params: unknown = {},
): RequestFrame {
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
): RequestFrame {
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

describe("dispatchFrame — daemon.hello", () => {
  it("succeeds pre-auth and returns a well-formed DaemonHelloResult/v1 shape", async () => {
    const deps = baseDeps();
    const connection = mintConnectionAuthState(counterRandomSource());
    const response = await dispatchFrame(
      deps,
      connection,
      requestFrame(1, DAEMON_HELLO_METHOD, "irrelevant"),
    );

    expect("result" in response).toBe(true);
    const result = (response as { result: Record<string, unknown> }).result;
    expect(result.schemaVersion).toBe(1);
    expect(result.protocolVersion).toBe(1);
    expect(result.instanceId).toBe("instance-1");
    expect(result.macAlgorithm).toBe("hmac-sha256");
    expect(result.keyId).toBe(KEY_ID);
    expect(typeof result.challenge).toBe("string");
    expect(result.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(connection.helloCalled).toBe(true);
  });

  it("rejects a second daemon.hello on the same connection with -32600, without re-minting or resetting state", async () => {
    const deps = baseDeps();
    const connection = mintConnectionAuthState(counterRandomSource());
    await dispatchFrame(deps, connection, requestFrame(1, DAEMON_HELLO_METHOD, "x"));

    const authenticated = signedFrame(deps, connection, 2, DAEMON_STATUS_METHOD, 5);
    const okResponse = await dispatchFrame(deps, connection, authenticated);
    expect("result" in okResponse).toBe(true);
    expect(connection.lastSequence).toBe(5);

    const second = await dispatchFrame(deps, connection, requestFrame(3, DAEMON_HELLO_METHOD, "y"));
    expect("error" in second).toBe(true);
    expect((second as { error: { code: number } }).error.code).toBe(-32600);
    // Untouched: helloCalled stays true, lastSequence stays 5.
    expect(connection.lastSequence).toBe(5);

    // The sequence-5 request cannot be replayed after the rejected re-hello.
    const replay = await dispatchFrame(deps, connection, authenticated);
    expect((replay as { error: { code: number } }).error.code).toBe(-32001);
  });
});

describe("dispatchFrame — no method-existence oracle", () => {
  it("unauthenticated daemon.status and an unauthenticated fabricated method produce byte-identical response lines", async () => {
    const deps = baseDeps();
    const connection1 = mintConnectionAuthState(counterRandomSource());
    const connection2 = mintConnectionAuthState(counterRandomSource());

    const realMethodResponse = await dispatchFrame(
      deps,
      connection1,
      requestFrame(
        1,
        DAEMON_STATUS_METHOD,
        '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}',
      ),
    );
    const fabricatedResponse = await dispatchFrame(
      deps,
      connection2,
      requestFrame(
        1,
        "daemon.notARealMethod",
        '{"jsonrpc":"2.0","id":1,"method":"daemon.notARealMethod","params":{}}',
      ),
    );

    const realLine = encodeResponseLine(realMethodResponse);
    const fabricatedLine = encodeResponseLine(fabricatedResponse);

    expect(realLine).toBe(fabricatedLine);
    expect(realLine).toContain('"code":-32001');
    expect(realLine).not.toContain('"data"');
  });
});

describe("dispatchFrame — authenticated dispatch", () => {
  it("routes an authenticated request to its registered handler", async () => {
    const deps = baseDeps({
      registry: createMethodRegistry([
        [DAEMON_STATUS_METHOD, () => ({ lifecycleState: "serving" })],
      ]),
    });
    const connection = mintConnectionAuthState(counterRandomSource());
    const frame = signedFrame(deps, connection, 1, DAEMON_STATUS_METHOD, 1);

    const response = await dispatchFrame(deps, connection, frame);
    expect("result" in response).toBe(true);
    expect((response as { result: unknown }).result).toEqual({ lifecycleState: "serving" });
  });

  it("returns -32601 for an authenticated but unregistered method", async () => {
    const deps = baseDeps();
    const connection = mintConnectionAuthState(counterRandomSource());
    const frame = signedFrame(deps, connection, 1, "daemon.notARealMethod", 1);

    const response = await dispatchFrame(deps, connection, frame);
    expect((response as { error: { code: number } }).error.code).toBe(-32601);
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

    const response = await dispatchFrame(deps, connection, frame);
    const errorBody = (response as { error: { code: number; message: string } }).error;
    expect(errorBody.code).toBe(-32603);
    expect(errorBody.message).not.toContain("/secret/path");
    expect(onHandlerError).toHaveBeenCalledWith(DAEMON_STATUS_METHOD, handlerError);
  });
});

describe("dispatchFrame — draining", () => {
  it("still answers daemon.hello normally while draining", async () => {
    const deps = baseDeps({ isDraining: () => true });
    const connection = mintConnectionAuthState(counterRandomSource());
    const response = await dispatchFrame(
      deps,
      connection,
      requestFrame(1, DAEMON_HELLO_METHOD, "x"),
    );
    expect("result" in response).toBe(true);
  });

  it("rejects daemon.status with -32000 draining while draining", async () => {
    const deps = baseDeps({ isDraining: () => true });
    const connection = mintConnectionAuthState(counterRandomSource());
    const frame = signedFrame(
      { ...deps, isDraining: () => false },
      connection,
      1,
      DAEMON_STATUS_METHOD,
      1,
    );
    const response = await dispatchFrame(deps, connection, frame);
    expect((response as { error: { code: number; message: string } }).error).toEqual({
      code: -32000,
      message: "draining",
    });
  });
});

describe("dispatchFrame — codec-level error frames pass through unchanged", () => {
  it("relays an error Frame's code, message, and id verbatim", async () => {
    const deps = baseDeps();
    const connection = mintConnectionAuthState(counterRandomSource());
    const errorFrame: ErrorFrame = {
      kind: "error",
      id: 5,
      code: -32700,
      message: "parse error",
      fatal: false,
    };

    const response = await dispatchFrame(deps, connection, errorFrame);
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: { code: -32700, message: "parse error" },
    });
  });
});
