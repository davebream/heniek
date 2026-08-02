/**
 * The method registry (design C8, plan Task 3 Step 6) — a
 * `Map<string, MethodHandler>` so a later HTTP+SSE adapter (design
 * Alternative F) can register against it without touching `dispatch.ts`.
 * This phase declares the namespace and the registry shape; the concrete
 * `daemon.status`/`daemon.recovery` handlers are wired in by a later
 * phase's composition root, once the lifecycle state machine (C9) and
 * reconciliation (C11/C12) they read from exist.
 */

export const DAEMON_HELLO_METHOD = "daemon.hello";
export const DAEMON_STATUS_METHOD = "daemon.status";
export const DAEMON_RECOVERY_METHOD = "daemon.recovery";

/**
 * Authenticated methods for Q008 — exactly these two. `daemon.hello` is
 * pre-auth and is never registered here. There is no third:
 * plan-review round 2, finding 13 withdrew `daemon.rotateCredential`, and
 * `daemon.shutdown` was never added — SIGTERM already covers graceful
 * drain and an RPC equivalent has no consumer (YAGNI).
 */
export const AUTHENTICATED_METHODS = [DAEMON_STATUS_METHOD, DAEMON_RECOVERY_METHOD] as const;

export type MethodHandler = (params: unknown) => unknown | Promise<unknown>;

export type MethodRegistry = ReadonlyMap<string, MethodHandler>;

export function createMethodRegistry(
  entries: Iterable<readonly [string, MethodHandler]>,
): MethodRegistry {
  return new Map(entries);
}
