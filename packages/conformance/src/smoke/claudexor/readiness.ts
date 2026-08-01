/**
 * Daemon readiness.
 *
 * Readiness must be decided by a **fresh** `GET /healthz` probe against the
 * daemon instance being started, and then confirmed by a `/v2` handshake whose
 * engine identity matches the pin. Two weaker rules both look adequate and
 * both fail the same way — by treating an observation about *some* daemon as
 * evidence about *this* one:
 *
 *  - Reading the daemon log. The log is not truncated by a new daemon, so a
 *    stale `control-api listening` line reads as ready while nothing listens.
 *    This produced a false ready during this spike.
 *  - Accepting any healthz 200 ever seen. `/healthz` is unauthenticated and
 *    outside `/v2`, so it cannot carry engine identity: a leftover daemon from
 *    a previous canary, or anything else bound to that loopback port, answers
 *    200 just as happily. Canary 4 restarts the daemon on the same home, so a
 *    pre-restart 200 must not authorise the post-restart instance.
 *
 * Hence `isDaemonReady` deliberately takes a **single, latest** observation
 * rather than a history, and callers must pair it with the handshake +
 * `assertPinnedEngine` check before treating the daemon as usable.
 *
 * Pure: no network, filesystem, process, or clock access. The caller performs
 * the probe and feeds the observation here.
 */

/** A single readiness observation, tagged with the instance it describes. */
export type DaemonReadinessProbe =
  | {
      readonly source: "healthz";
      readonly status: number;
      /** Port the probe was issued against — must be this daemon's port. */
      readonly port: number;
      /** Monotonic attempt counter within the current start sequence. */
      readonly attempt: number;
    }
  | { readonly source: "log"; readonly line: string };

/**
 * True only for a fresh `GET /healthz` 200 against the expected port.
 *
 * Takes one probe, not a list: an "any probe ever" rule is exactly how a
 * stale observation authorises the wrong daemon instance.
 */
export function isDaemonReady(probe: DaemonReadinessProbe, expectedPort: number): boolean {
  return probe.source === "healthz" && probe.status === 200 && probe.port === expectedPort;
}
