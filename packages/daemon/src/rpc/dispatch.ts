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
import {
  DAEMON_HELLO_METHOD,
  DAEMON_NEGOTIATE_METHOD,
  DAEMON_RECOVERY_V1_METHOD,
  DAEMON_STATUS_V1_METHOD,
  type MethodContext,
  type MethodRegistry,
  RPC_CANCEL_METHOD,
} from "./methods.js";

const STATUS_SCHEMA_ID = "heniek://contract/DaemonStatus/v1";
const STATUS_SCHEMA_SHA256 = "a91375e3509ceb2663a96e656d18e32c722085a1cb574328159cee7ff4fef854";
const RECOVERY_SCHEMA_ID = "heniek://contract/DaemonRecoveryResult/v1";
const RECOVERY_SCHEMA_SHA256 = "8c4099c58b018a809e8708451e33ccdc4e24fa74fb65865d35953af9f3672e9a";
const CONTRACT_MANIFEST_VERSION = "heniek.contracts-manifest.v1";

export interface DispatchDeps {
  readonly registry: MethodRegistry;
  readonly credential: AuthenticatedCredential;
  readonly macProvider: MacProvider;
  readonly instanceId: string;
  readonly protocolVersion: number;
  readonly isDraining: () => boolean;
  /** The full handler error, never surfaced on the wire — a bare `-32603` is sent instead (design's Error Handling section). */
  readonly onHandlerError?: (method: string, error: unknown) => void;
  readonly createRequestContext?: (id: JsonRpcRequestFrame["id"]) => MethodContext | undefined;
  readonly finishRequest?: (id: JsonRpcRequestFrame["id"]) => void;
  readonly cancelRequest?: (id: JsonRpcRequestFrame["id"]) => boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNegotiationParams(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "auth,requiredMethods,schemaVersion,transportVersions") {
    return false;
  }
  if (value.schemaVersion !== 1 || !Array.isArray(value.transportVersions)) {
    return false;
  }
  if (
    !value.transportVersions.every((version) => version === 1) ||
    !Array.isArray(value.requiredMethods)
  ) {
    return false;
  }
  return value.requiredMethods.every((method) => {
    if (!isRecord(method) || typeof method.name !== "string") {
      return false;
    }
    return (
      Array.isArray(method.methodVersions) &&
      method.methodVersions.every((version) => version === 1) &&
      Array.isArray(method.resultSchemas) &&
      method.resultSchemas.every(
        (schema) =>
          isRecord(schema) &&
          typeof schema.schemaId === "string" &&
          typeof schema.sha256 === "string",
      )
    );
  });
}

function cancelRequestId(value: unknown): JsonRpcRequestFrame["id"] | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return undefined;
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "auth,requestId,schemaVersion") {
    return undefined;
  }
  const requestId = value.requestId;
  return typeof requestId === "string" ||
    (typeof requestId === "number" && Number.isInteger(requestId))
    ? requestId
    : undefined;
}

function cancelled(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("request cancelled")), { once: true });
  });
}

function negotiateResult(params: Record<string, unknown>) {
  const requiredMethods = params.requiredMethods as readonly Record<string, unknown>[];
  const requestedTransport = params.transportVersions as readonly number[];
  const reasons: Array<"NO_COMMON_TRANSPORT" | "METHOD_UNAVAILABLE" | "RESULT_SCHEMA_UNAVAILABLE"> =
    [];
  if (!requestedTransport.includes(1)) {
    reasons.push("NO_COMMON_TRANSPORT");
  }
  const methods: Array<{
    name: string;
    methodVersion: 1;
    wireMethod: string;
    resultSchemaId: string;
    resultSchemaSha256: string;
  }> = [];
  for (const required of requiredMethods) {
    const name = required.name as string;
    const versions = required.methodVersions as readonly number[];
    const schemas = required.resultSchemas as readonly Record<string, unknown>[];
    if ((name !== "daemon.status" && name !== "daemon.recovery") || !versions.includes(1)) {
      reasons.push("METHOD_UNAVAILABLE");
      continue;
    }
    const resultSchemaId = name === "daemon.status" ? STATUS_SCHEMA_ID : RECOVERY_SCHEMA_ID;
    const resultSchemaSha256 =
      name === "daemon.status" ? STATUS_SCHEMA_SHA256 : RECOVERY_SCHEMA_SHA256;
    const schema = schemas.find(
      (candidate) =>
        candidate.schemaId === resultSchemaId && candidate.sha256 === resultSchemaSha256,
    );
    if (schema === undefined) {
      reasons.push("RESULT_SCHEMA_UNAVAILABLE");
      continue;
    }
    methods.push({
      name,
      methodVersion: 1,
      wireMethod: name === "daemon.status" ? DAEMON_STATUS_V1_METHOD : DAEMON_RECOVERY_V1_METHOD,
      resultSchemaId,
      resultSchemaSha256,
    });
  }
  const compatibility = reasons.length === 0 ? "compatible" : "incompatible";
  return {
    schemaVersion: 1,
    compatibility,
    selectedTransportVersion: compatibility === "compatible" ? 1 : null,
    contractManifestVersion: CONTRACT_MANIFEST_VERSION,
    methods,
    reasons: [...new Set(reasons)],
  };
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
  if (
    (frame.method === DAEMON_STATUS_V1_METHOD || frame.method === DAEMON_RECOVERY_V1_METHOD) &&
    !connection.negotiated
  ) {
    return encodeError(frame.id, ERROR_CODES.protocolNotNegotiated, "protocol not negotiated");
  }

  if (frame.method === DAEMON_NEGOTIATE_METHOD) {
    if (connection.negotiationCalled) {
      return encodeError(
        frame.id,
        ERROR_CODES.invalidRequest,
        "daemon.negotiate already called on this connection",
      );
    }
    if (!isNegotiationParams(frame.params)) {
      return encodeError(frame.id, ERROR_CODES.invalidParams, "invalid params");
    }
    const result = negotiateResult(frame.params);
    connection.negotiationCalled = true;
    if (result.compatibility === "compatible") {
      connection.negotiated = true;
    }
    return encodeResult(frame.id, result);
  }

  if (frame.method === RPC_CANCEL_METHOD) {
    const requestId = cancelRequestId(frame.params);
    if (requestId === undefined) {
      return encodeError(frame.id, ERROR_CODES.invalidParams, "invalid params");
    }
    return encodeResult(frame.id, {
      schemaVersion: 1,
      accepted: deps.cancelRequest?.(requestId) ?? false,
    });
  }

  if (handler === undefined) {
    return encodeError(frame.id, ERROR_CODES.methodNotFound, "method not found");
  }

  const createdContext = deps.createRequestContext?.(frame.id);
  if (deps.createRequestContext !== undefined && createdContext === undefined) {
    return encodeError(frame.id, ERROR_CODES.invalidRequest, "duplicate active request id");
  }
  const context: MethodContext = createdContext ?? { signal: new AbortController().signal };
  try {
    const result = await Promise.race([
      Promise.resolve(handler(frame.params, context)),
      cancelled(context.signal),
    ]);
    return encodeResult(frame.id, result);
  } catch (error) {
    if (context.signal.aborted) {
      return encodeError(frame.id, ERROR_CODES.requestCancelled, "request cancelled");
    }
    // The full error — never a stack trace or a path — goes to the trace
    // sink via the caller-supplied hook; a bare `-32603` goes to the wire.
    deps.onHandlerError?.(frame.method, error);
    return encodeError(frame.id, ERROR_CODES.internal, "internal error");
  } finally {
    deps.finishRequest?.(frame.id);
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
