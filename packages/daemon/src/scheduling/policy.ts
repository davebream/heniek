import type {
  ExecutionFailureV1,
  ExecutionPermissionEnvelopeV1,
  ResolvedProfileV2,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";

type Failure = Static<typeof ExecutionFailureV1>;
type PermissionEnvelope = Static<typeof ExecutionPermissionEnvelopeV1>;
type Profile = Static<typeof ResolvedProfileV2>;

export interface ExecutionLimitsInput {
  readonly maxDurationMs?: number;
  readonly maxTurns?: number;
}

const FALLBACK_ELIGIBLE_CLASSES: ReadonlySet<Failure["classification"]> = new Set([
  "account_unavailable",
  "profile_unavailable",
  "model_unavailable",
  "engine_unavailable",
  "provider_throttled",
  "context_capacity_exhausted",
]);

export function isFallbackEligibleFailure(failure: Failure): boolean {
  return failure.fallbackEligible && FALLBACK_ELIGIBLE_CLASSES.has(failure.classification);
}

export type PermissionResolution =
  | { readonly ok: true; readonly permissions: PermissionEnvelope }
  | { readonly ok: false; readonly reason: "primary_denied" | "candidate_denied" };

/** The primary profile is the immutable ceiling; a candidate may only narrow it. */
export function resolveAttemptPermissions(
  primary: Pick<Profile, "permissions">,
  candidate: Pick<Profile, "permissions">,
  requestedIdentifiers: readonly string[],
): PermissionResolution {
  const primaryAllowed = new Set(primary.permissions.identifiers);
  const candidateAllowed = new Set(candidate.permissions.identifiers);
  for (const identifier of requestedIdentifiers) {
    if (!primaryAllowed.has(identifier)) return { ok: false, reason: "primary_denied" };
    if (!candidateAllowed.has(identifier)) return { ok: false, reason: "candidate_denied" };
  }
  return {
    ok: true,
    permissions: {
      schemaVersion: 1,
      workspace:
        primary.permissions.workspace === "read-only" ||
        candidate.permissions.workspace === "read-only"
          ? "read-only"
          : "read-write",
      identifiers: [...requestedIdentifiers],
    },
  };
}

function minimumDefined(values: readonly (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0 ? undefined : Math.min(...defined);
}

/** Recomputed per candidate; the original absolute hard deadline can only reduce duration. */
export function resolveAttemptLimits(input: {
  readonly stage: ExecutionLimitsInput;
  readonly invocation: ExecutionLimitsInput;
  readonly profileMaxDurationMs?: number;
  readonly hardDeadlineAt?: string;
  readonly now: string;
}): ExecutionLimitsInput {
  const remaining =
    input.hardDeadlineAt === undefined
      ? undefined
      : Math.max(0, Date.parse(input.hardDeadlineAt) - Date.parse(input.now));
  const maxDurationMs = minimumDefined([
    input.stage.maxDurationMs,
    input.invocation.maxDurationMs,
    input.profileMaxDurationMs,
    remaining,
  ]);
  const maxTurns = minimumDefined([input.stage.maxTurns, input.invocation.maxTurns]);
  return {
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
  };
}
