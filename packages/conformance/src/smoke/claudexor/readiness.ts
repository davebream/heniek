/**
 * Daemon readiness resolution.
 *
 * Readiness must be decided by an HTTP `GET /healthz` probe, never by reading
 * the daemon's log file. The log lives at a fixed path under the daemon home
 * and is *not* truncated by a new daemon, so a stale `control-api listening`
 * line left by a previous process reads as "ready" while nothing is listening.
 * That defect produced a false ready during this spike; `resolveReadiness`
 * exists so it cannot be re-introduced silently.
 *
 * Pure: no network, filesystem, process, or clock access. The caller performs
 * the probes and feeds the observations here.
 */

/** A single readiness observation. */
export type DaemonReadinessProbe =
  | { readonly source: "healthz"; readonly status: number }
  | { readonly source: "log"; readonly line: string };

/** Outcome of resolving a batch of readiness observations. */
export interface ReadinessOutcome {
  readonly ready: boolean;
  /** Which observation authorised readiness; `null` when not ready. */
  readonly via: "healthz" | null;
}

/** True only for a `GET /healthz` observation that returned HTTP 200. */
export function isDaemonReady(probe: DaemonReadinessProbe): boolean {
  return probe.source === "healthz" && probe.status === 200;
}

/**
 * Resolve readiness from every observation gathered so far.
 *
 * Log observations are accepted as input and are always non-authoritative:
 * no quantity of them, and no content within them, can yield `ready`.
 */
export function resolveReadiness(probes: readonly DaemonReadinessProbe[]): ReadinessOutcome {
  for (const probe of probes) {
    if (isDaemonReady(probe)) {
      return { ready: true, via: "healthz" };
    }
  }
  return { ready: false, via: null };
}
