import type { FaultKind } from "../contract/fault.js";

export interface FaultProgrammeEntry {
  readonly fault: FaultKind;
  readonly occurrences: number;
}

/** A deterministic, ordered (FIFO) queue of faults to be consumed one at a time. */
export interface FaultProgramme {
  /** Consumes and returns the next programmed fault, or `undefined` if none remain. */
  consume(): FaultKind | undefined;
  /** Adds another fault entry to the programme after creation (e.g. targeting an existing run). */
  enqueue(entry: FaultProgrammeEntry): void;
}

interface RemainingEntry {
  readonly fault: FaultKind;
  remaining: number;
}

/**
 * Builds a fault programme from `entries`, served strictly in the order they
 * were supplied (FIFO) — insertion order for the initial `entries`, then
 * append order for anything added later via `enqueue`. This is what design
 * §5 means by "an ordered FaultProgramme": a prior revision instead drew the
 * next fault via `random.nextInt`, which is deterministic but *not*
 * ordered — served in a fixed-but-arbitrary sequence rather than the
 * sequence the caller enqueued them in — contradicting both this docblock
 * and design §5's own wording. `consume()` previously took an `operation:
 * string` parameter that no call site ever read (every fault programme in
 * this package is scoped per-run or per-PR, never per-operation); it has
 * been removed rather than kept as dead API surface. A future need for
 * per-operation scoping should thread the operation name through
 * `FaultProgrammeEntry` (e.g. `{ operation, fault, occurrences }`) so
 * `consume()` can filter by it, rather than resurrecting an ignored
 * parameter.
 */
export function createFaultProgramme(entries: readonly FaultProgrammeEntry[]): FaultProgramme {
  const remaining: RemainingEntry[] = entries
    .filter((entry) => entry.occurrences > 0)
    .map((entry) => ({ fault: entry.fault, remaining: entry.occurrences }));

  return {
    consume(): FaultKind | undefined {
      const chosen = remaining[0];
      if (chosen === undefined) {
        return undefined;
      }
      chosen.remaining -= 1;
      const fault = chosen.fault;
      if (chosen.remaining <= 0) {
        remaining.shift();
      }
      return fault;
    },
    enqueue(entry: FaultProgrammeEntry): void {
      if (entry.occurrences > 0) {
        remaining.push({ fault: entry.fault, remaining: entry.occurrences });
      }
    },
  };
}
