/**
 * Determinism ports (design D14). Ports only — no default implementation
 * ships in `src/`. Both are **required** parameters of `openStateDatabase`:
 * an optional parameter defaulting to `Date.now()` would make the
 * deterministic path the one callers have to remember to opt into, and E2's
 * byte-reproducible replay report would be unachievable the first time
 * someone forgets. `src/**` must contain no wall-clock, random, or network
 * source at all — Phase 5's scan enforces this mechanically.
 */

/** ISO-8601 UTC with milliseconds, e.g. "2026-01-01T00:00:00.000Z". */
export interface Clock {
  nowIso(): string;
}

/** Opaque, collision-free id generator. `prefix` names the id family ("evt", "cor"). */
export interface IdGenerator {
  next(prefix: string): string;
}
