/**
 * Determinism ports (design D14). Ports only — no default implementation
 * ships in `src/`. Both are **required** parameters of `openStateDatabase`:
 * an optional parameter with a wall-clock default would make the
 * deterministic path the one callers have to remember to opt into, and E2's
 * byte-reproducible replay report would be unachievable the first time
 * someone forgets. `src/**` must contain no wall-clock, random, or network
 * source at all — Phase 5's scan enforces this mechanically (issue #7, fix
 * N1: this comment must never spell out the literal wall-clock call it
 * warns against, since the scan's regex applies to raw file content with no
 * comment stripping and would otherwise flag this very sentence).
 */

/** ISO-8601 UTC with milliseconds, e.g. "2026-01-01T00:00:00.000Z". */
export interface Clock {
  nowIso(): string;
}

/** Opaque, collision-free id generator. `prefix` names the id family ("evt", "cor"). */
export interface IdGenerator {
  next(prefix: string): string;
}
