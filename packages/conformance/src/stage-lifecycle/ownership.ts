import type { RunStatus } from "@heniek/contracts";

/**
 * `waiting_for_parent_session` is exclusively owned by the native bridge
 * (ADR 0021) — it is Heniek-owned, never backend-reported (§18.3), and every
 * other `RunStatus` producer in the repo must be structurally incapable of
 * emitting it. `packages/conformance/test/claudexor-state-map.test.ts`
 * already pinned this for the one mapper that existed before Q023; this is
 * the general form.
 *
 * Each sample is a mapper's own exhaustively-enumerated output set over its
 * full input domain, computed by the caller — only the caller knows how to
 * enumerate its mapper's domain (Claudexor's is a finite state x boolean
 * cross product; a future mapper's might not be). Reducing this to a plain
 * set-membership check means a second external mapper is a one-line
 * addition to the sample list a test builds, never a change to this file.
 */
export interface RunStatusMapperSample {
  readonly mapperName: string;
  readonly producedStatuses: ReadonlySet<RunStatus>;
}

export interface OwnershipViolation {
  readonly mapperName: string;
}

export interface OwnershipCheckResult {
  readonly ok: boolean;
  readonly violations: readonly OwnershipViolation[];
}

const NATIVE_BRIDGE_OWNED_STATUS: RunStatus = "waiting_for_parent_session";

export function checkNoExternalMapperOwnsWaitingForParentSession(
  samples: readonly RunStatusMapperSample[],
): OwnershipCheckResult {
  const violations = samples
    .filter((sample) => sample.producedStatuses.has(NATIVE_BRIDGE_OWNED_STATUS))
    .map((sample) => ({ mapperName: sample.mapperName }));
  return { ok: violations.length === 0, violations };
}
