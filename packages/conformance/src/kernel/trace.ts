import { canonicalize, type JsonValue } from "./json.js";

/** One recorded step of a conformance scenario, used to build the replay evidence (RE2). */
export interface TraceEvent {
  /** Monotonic step index, assigned by the recorder — never supplied by the caller. */
  readonly step: number;
  /** `FakeClock` time in epoch milliseconds; never wall-clock time. */
  readonly atMs: number;
  /** The subject that produced this event, e.g. `"execution-backend"`. */
  readonly actor: string;
  /** The operation performed, e.g. `"status"`. */
  readonly action: string;
  readonly outcome: "ok" | "fault";
  /** Canonicalized (sorted-key) JSON detail describing the event. */
  readonly detail: JsonValue;
}

export interface TraceRecorder {
  /** Records one event; `step` is assigned automatically and the event is frozen. */
  record(event: Omit<TraceEvent, "step">): void;
  readonly events: readonly TraceEvent[];
  /** The full replay-evidence payload: the seed plus every recorded event. */
  toJson(): { readonly seed: number; readonly events: readonly TraceEvent[] };
}

export function createTraceRecorder(seedValue: number): TraceRecorder {
  const events: TraceEvent[] = [];
  let nextStep = 0;

  return {
    record(event: Omit<TraceEvent, "step">): void {
      const full: TraceEvent = Object.freeze({
        step: nextStep,
        atMs: event.atMs,
        actor: event.actor,
        action: event.action,
        outcome: event.outcome,
        detail: canonicalize(event.detail),
      });
      nextStep += 1;
      events.push(full);
    },
    events,
    toJson(): { readonly seed: number; readonly events: readonly TraceEvent[] } {
      return { seed: seedValue, events: [...events] };
    },
  };
}
