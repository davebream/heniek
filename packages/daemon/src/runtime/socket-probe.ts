/**
 * The real `SocketProbe` adapter (design C2, plan Task 5 Steps 2 and 8) —
 * connects to a candidate `daemon.sock`, sends one `daemon.hello` request,
 * reads one NDJSON line, and hands what it observed to the pure
 * `src/lifecycle/probe.ts:classifyProbeOutcome` classifier. This module
 * owns the only `node:net` client socket in the package that exists purely
 * to *ask* whether a daemon is there — `src/runtime/socket-server.ts` owns
 * the listening side.
 *
 * **The errno mapping is total** (plan-review round 1 reviewer B, finding
 * MINOR 4): only `ECONNREFUSED`, `ENOENT`, and `EACCES` map to
 * `connection-refused`/`socket-absent`/`connection-denied` respectively;
 * every other errno — `EAGAIN`, `ETIMEDOUT`, `ELOOP`, `ENOTSOCK`,
 * `ENAMETOOLONG`, `EPERM`, and anything unlisted — falls through to
 * `protocol-violation`, which `classifyProbeOutcome` maps to `hostile`.
 * `hostile` authorises nothing, so an unrecognised errno reaching
 * `no-listener` or `absent` (which authorise an unlink) is the dangerous
 * default this mapping refuses to produce.
 *
 * No deadline: the plan's Task 4 Step 8 note settled the probe deadline as
 * *omitted*, and Task 5's allowlist explicitly does not add a `deadline.ts`
 * — a hung peer that accepts the connection and never answers is exactly
 * the `hostile` case (no line before the peer closes is also `hostile`;
 * a peer that never closes either is a protocol violation this design
 * accepts as a known residual, not one this probe resolves with a timer).
 */

import { createConnection, type Socket } from "node:net";
import { classifyProbeOutcome, type ProbeAttemptOutcome } from "../lifecycle/probe.js";
import type { SocketProbe, SocketProbeVerdict } from "../ports.js";
import { MAX_LINE_BYTES } from "../rpc/codec.js";

const HELLO_REQUEST_LINE = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.hello" })}\n`;

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function mapConnectError(error: unknown): ProbeAttemptOutcome {
  if (isErrnoCode(error, "ECONNREFUSED")) {
    return { kind: "connection-refused" };
  }
  if (isErrnoCode(error, "ENOENT")) {
    return { kind: "socket-absent" };
  }
  if (isErrnoCode(error, "EACCES")) {
    return { kind: "connection-denied" };
  }
  return { kind: "protocol-violation" };
}

/** A well-formed `DaemonHelloResult/v1` response line, per design C4. */
function isWellFormedHelloLine(line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return false;
  }
  const record = parsed as { result?: unknown };
  const result = record.result;
  if (typeof result !== "object" || result === null) {
    return false;
  }
  const hello = result as {
    protocolVersion?: unknown;
    instanceId?: unknown;
    challenge?: unknown;
    macAlgorithm?: unknown;
    keyId?: unknown;
  };
  return (
    typeof hello.protocolVersion === "number" &&
    typeof hello.instanceId === "string" &&
    typeof hello.challenge === "string" &&
    hello.macAlgorithm === "hmac-sha256" &&
    typeof hello.keyId === "string"
  );
}

function probeOnce(path: string): Promise<SocketProbeVerdict> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let socket: Socket;

    function finish(outcome: ProbeAttemptOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(classifyProbeOutcome(outcome));
    }

    socket = createConnection({ path });

    socket.on("connect", () => {
      socket.write(HELLO_REQUEST_LINE);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        if (buffer.length > MAX_LINE_BYTES) {
          finish({ kind: "protocol-violation" });
        }
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      finish(
        isWellFormedHelloLine(line) ? { kind: "hello-accepted" } : { kind: "protocol-violation" },
      );
    });

    socket.on("error", (error: unknown) => {
      finish(mapConnectError(error));
    });

    // The peer closed without ever sending a complete line — accept-then-close.
    socket.on("close", () => {
      finish({ kind: "protocol-violation" });
    });
  });
}

export function createNodeSocketProbe(): SocketProbe {
  return {
    probe(path: string): Promise<SocketProbeVerdict> {
      return probeOnce(path);
    },
  };
}
