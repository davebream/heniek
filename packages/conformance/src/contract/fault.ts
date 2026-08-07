/** Provider-neutral fault vocabulary (AC2). */
export const FAULT_KINDS = [
  "disconnect",
  "rate_limit",
  "stale_ref",
  "conflict",
  "crash",
  "malformed_response",
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

/**
 * Thrown by every bundled fake to signal an injected or arranged fault.
 * Third-party adapters are not required to throw this — the harness's
 * `classifyFault` maps whatever error shape the adapter throws onto
 * `FaultKind | "unknown"` instead (design §2).
 */
export class ConformanceFaultError extends Error {
  readonly kind: FaultKind;
  readonly retryable: boolean;

  constructor(kind: FaultKind, retryable: boolean, message?: string) {
    super(message ?? `conformance fault: ${kind}`);
    this.name = "ConformanceFaultError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

export function isConformanceFaultError(value: unknown): value is ConformanceFaultError {
  return value instanceof ConformanceFaultError;
}

/**
 * Thrown when a case calls `arrange` with an arrangement whose capability a
 * harness *declared* but cannot actually honour. This is a conformance
 * failure, not a skip — a declared-but-unhonoured capability is exactly the
 * silent coverage gap the capability mechanism exists to prevent.
 */
export class UnsupportedArrangementError extends Error {
  constructor(harnessName: string, arrangementKind: string) {
    super(
      `Harness "${harnessName}" declared support for an arrangement it cannot honour: ${arrangementKind}`,
    );
    this.name = "UnsupportedArrangementError";
  }
}
