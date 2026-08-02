/**
 * The dispatcher (design C8, plan Task 3 Step 6). Order is mandated, not
 * chosen: envelope validation (already done by `src/rpc/codec.ts` before a
 * request `Frame` ever reaches this module) → `daemon.hello` → drain check
 * → authenticate → registry lookup → handler. Because authentication
 * precedes lookup, an unauthenticated caller receives the byte-identical
 * `-32001` line for a real method and a fabricated one alike — there is no
 * method-existence oracle (STD-8, STD-9).
 *
 * `dispatchFrame` returns the exact NDJSON wire line — `src/rpc/codec.ts`'s
 * `encodeResult`/`encodeError` build it — so a caller (a test, or the
 * future `src/runtime/socket-server.ts`) never re-serialises a response
 * object itself, which is exactly the kind of second encoding path that
 * could let a byte-identical invariant erode.
 */

import type { ConnectionAuthState } from "../auth/challenge.js";
import { UNAUTHORIZED_MESSAGE } from "../auth/errors.js";
import type { AuthenticatedCredential } from "../auth/verify.js";
import { bytesToHex, verifyRequest } from "../auth/verify.js";
import type { MacProvider } from "../ports.js";
import {
  ERROR_CODES,
  encodeError,
  encodeResult,
  type Frame,
  type JsonRpcRequestFrame,
} from "./codec.js";
import { DRAINING_MESSAGE } from "./errors.js";
import { DAEMON_HELLO_METHOD, type MethodRegistry } from "./methods.js";

export interface DispatchDeps {
  readonly registry: MethodRegistry;
  readonly credential: AuthenticatedCredential;
  readonly macProvider: MacProvider;
  readonly instanceId: string;
  readonly protocolVersion: number;
  readonly isDraining: () => boolean;
  /** The full handler error, never surfaced on the wire — a bare `-32603` is sent instead (design's Error Handling section). */
  readonly onHandlerError?: (method: string, error: unknown) => void;
}

function helloResultLine(
  deps: DispatchDeps,
  connection: ConnectionAuthState,
  id: JsonRpcRequestFrame["id"],
): string {
  return encodeResult(id, {
    schemaVersion: 1,
    protocolVersion: deps.protocolVersion,
    instanceId: deps.instanceId,
    challenge: bytesToHex(connection.challenge),
    macAlgorithm: "hmac-sha256",
    keyId: deps.credential.keyId,
  });
}

async function dispatchRequest(
  deps: DispatchDeps,
  connection: ConnectionAuthState,
  frame: JsonRpcRequestFrame,
): Promise<string> {
  if (frame.method === DAEMON_HELLO_METHOD) {
    if (connection.helloCalled) {
      // Never re-mints the challenge or resets `lastSequence` (plan-review
      // round 1, finding m5) — the reject happens before either is touched.
      return encodeError(
        frame.id,
        ERROR_CODES.invalidRequest,
        "daemon.hello already called on this connection",
      );
    }
    connection.helloCalled = true;
    return helloResultLine(deps, connection, frame.id);
  }

  if (deps.isDraining()) {
    // Every method except `daemon.hello` is rejected while draining (design
    // C9) — checked before authentication, since a draining daemon accepts
    // no new work regardless of who is asking.
    return encodeError(frame.id, ERROR_CODES.draining, DRAINING_MESSAGE);
  }

  const verifyResult = verifyRequest(deps.macProvider, deps.credential, connection, frame.raw);
  if (verifyResult.kind === "malformed-envelope") {
    return encodeError(frame.id, ERROR_CODES.invalidRequest, "invalid JSON-RPC envelope");
  }
  if (verifyResult.kind === "unauthorized") {
    // Uniform, no `data` — byte-identical whether `frame.method` names a
    // real method or a fabricated one (STD-8, STD-9): `-32601` is
    // unreachable from here.
    return encodeError(frame.id, ERROR_CODES.unauthorized, UNAUTHORIZED_MESSAGE);
  }

  const handler = deps.registry.get(frame.method);
  if (handler === undefined) {
    return encodeError(frame.id, ERROR_CODES.methodNotFound, "method not found");
  }

  try {
    const result = await handler(frame.params);
    return encodeResult(frame.id, result);
  } catch (error) {
    // The full error — never a stack trace or a path — goes to the trace
    // sink via the caller-supplied hook; a bare `-32603` goes to the wire.
    deps.onHandlerError?.(frame.method, error);
    return encodeError(frame.id, ERROR_CODES.internal, "internal error");
  }
}

/**
 * Dispatches one already-decoded `Frame`, mutating `connection` in place —
 * `helloCalled`/`lastSequence` are per-connection state a real socket
 * adapter owns across many calls. Every case in this phase drives it
 * directly with fabricated frames; the assembled-system tests in a later
 * phase exercise it over a real connection (design's Testing Strategy).
 */
export async function dispatchFrame(
  deps: DispatchDeps,
  connection: ConnectionAuthState,
  frame: Frame,
): Promise<string> {
  if (frame.kind === "error") {
    return encodeError(frame.id, frame.code, frame.message);
  }
  return dispatchRequest(deps, connection, frame);
}
