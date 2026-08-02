/**
 * `LifecycleTracer` — the observable-state layer over `state.ts`'s pure
 * transition function (design C9, plan Task 6 Step 7). This is what OR-19
 * asks for as evidence: not just a terminal outcome, but one NDJSON line
 * `{from, to, reason, instanceId, at}` per transition, emitted to the
 * injected `LifecycleTraceSink`.
 *
 * `at` comes from the injected `Clock` (`@heniek/state`'s port, re-exported
 * by `../ports.js`) — never an ambient `Date` read — so this module stays
 * pure and outside `src/runtime/**`'s carve-out, matching `state.ts`.
 *
 * `createLifecycleTracer`'s `initialState` defaults to `starting`. A second,
 * independent tracer resuming at `serving` is how the composition root
 * (`src/runtime/compose.ts`) continues the same instance's trace into the
 * served lifetime (`serving → draining → stopped`, or `serving → lost`)
 * once `src/lifecycle/acquire.ts`'s own tracer — which only ever needs to
 * reach `serving`, `lost`, or `refused` — has returned. Both tracers write
 * to the same sink and carry the same `instanceId`, so the two write one
 * seamless sequence from the reader's point of view even though they are
 * two separate closures.
 */

import type { Clock, LifecycleTraceEvent, LifecycleTraceSink } from "../ports.js";
import {
  INITIAL_LIFECYCLE_STATE,
  type LifecycleEventKind,
  type LifecycleState,
  transitionLifecycleState,
} from "./state.js";

export interface LifecycleTracer {
  readonly instanceId: string;
  /** The state reached by the most recent `record()` call (or the initial state, if none yet). */
  currentState(): LifecycleState;
  /** Computes the next state via `transitionLifecycleState`, emits one trace line, and returns the new state. */
  record(event: LifecycleEventKind, reason: string): LifecycleState;
}

export interface CreateLifecycleTracerOptions {
  readonly instanceId: string;
  readonly sink: LifecycleTraceSink;
  readonly clock: Clock;
  /** Defaults to `starting` — set to resume an existing instance's trace at a later state (see this file's docblock). */
  readonly initialState?: LifecycleState;
}

export function createLifecycleTracer(options: CreateLifecycleTracerOptions): LifecycleTracer {
  let state: LifecycleState = options.initialState ?? INITIAL_LIFECYCLE_STATE;

  return {
    instanceId: options.instanceId,

    currentState(): LifecycleState {
      return state;
    },

    record(event: LifecycleEventKind, reason: string): LifecycleState {
      const from = state;
      const to = transitionLifecycleState(from, event);
      state = to;
      const trace: LifecycleTraceEvent = {
        from,
        to,
        reason,
        instanceId: options.instanceId,
        at: options.clock.nowIso(),
      };
      options.sink.emit(trace);
      return to;
    },
  };
}

/**
 * NDJSON serialisation of an already-collected trace (OR-19's "the literal
 * artifact"). A caller collecting `LifecycleTraceEvent`s from an in-memory
 * sink into an array can hand that array here for the evidence sidecar or a
 * test assertion — one line per event, in order, each `JSON.stringify`d and
 * newline-terminated, mirroring `src/runtime/trace-sink.ts`'s own wire
 * format exactly.
 */
export function serialiseLifecycleTrace(events: readonly LifecycleTraceEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}
