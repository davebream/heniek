/**
 * Every conformance capability a subject may declare. A subject that omits a
 * capability is never driven into cases that `requires` it (design §2) — a
 * skip is always attributable to a named, missing capability rather than a
 * silent pass.
 */
export const CONFORMANCE_CAPABILITIES = [
  "lifecycle",
  "interaction",
  "resume",
  "cancellation",
  "malformed-response",
  "fault-disconnect",
  "fault-rate-limit",
  "fault-stale-ref",
  "fault-conflict",
  "fault-crash-recovery",
] as const;

export type ConformanceCapability = (typeof CONFORMANCE_CAPABILITIES)[number];

/** True when every capability in `required` is present in `declared`. */
export function hasCapabilities(
  declared: readonly ConformanceCapability[],
  required: readonly ConformanceCapability[],
): boolean {
  return missingCapabilities(declared, required).length === 0;
}

/** The subset of `required` that `declared` does not contain, in `required` order. */
export function missingCapabilities(
  declared: readonly ConformanceCapability[],
  required: readonly ConformanceCapability[],
): readonly ConformanceCapability[] {
  const declaredSet = new Set(declared);
  return required.filter((capability) => !declaredSet.has(capability));
}
