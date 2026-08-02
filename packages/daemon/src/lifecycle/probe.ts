/**
 * The pure probe-verdict classifier (design C2). Turns the raw outcome of
 * one connect/send/read attempt against a candidate `daemon.sock` into one
 * of the four `SocketProbeVerdict`s. No I/O: `src/runtime/socket-probe.ts`
 * (Phase 5) is the `node:net` adapter that actually connects, sends one
 * `daemon.hello` request, reads one NDJSON line, and calls this function
 * with what it observed. Kept separate from the adapter so the
 * classification rule itself — the part with real decision content — stays
 * unit-testable without a socket.
 *
 * `hostile` is never collapsed into `no-listener` (a same-uid actor who
 * pre-binds `daemon.sock` must never cause a starting daemon to unlink
 * their socket), and never into `serving` (the condition is reported, never
 * silently accepted).
 */

import type { SocketProbeVerdict } from "../ports.js";

/**
 * What `src/runtime/socket-probe.ts` observed while probing a candidate
 * socket. Exactly one variant applies per attempt.
 */
export type ProbeAttemptOutcome =
  /** `ECONNREFUSED` — the path is a socket, but nothing is listening (stale). */
  | { readonly kind: "connection-refused" }
  /** `ENOENT` — nothing exists at the path. */
  | { readonly kind: "socket-absent" }
  /** `EACCES` — permission denied connecting to the path. */
  | { readonly kind: "connection-denied" }
  /** A connection was made and a well-formed `DaemonHelloResult/v1` line was read back. */
  | { readonly kind: "hello-accepted" }
  /**
   * Everything else that is not one of the three named errnos or a
   * well-formed hello: accept-then-close, a malformed or oversize line, no
   * line before the peer closes, or any other errno.
   */
  | { readonly kind: "protocol-violation" };

export function classifyProbeOutcome(outcome: ProbeAttemptOutcome): SocketProbeVerdict {
  switch (outcome.kind) {
    case "connection-refused":
      return "no-listener";
    case "socket-absent":
      return "absent";
    case "connection-denied":
      return "hostile";
    case "hello-accepted":
      return "serving";
    case "protocol-violation":
      return "hostile";
  }
}
