/**
 * The pure lifecycle transition function (design C9, plan Task 6 Step 7).
 *
 * States: `starting → acquiring → recovering → serving → draining →
 * stopped`, plus the terminal `lost` and `refused`. `acquiring` carries
 * explicit sub-phases — `claim`, `probe`, `reclaim`, `takeover` — that are
 * self-transitions (`acquiring → acquiring`) rather than distinct states, so
 * the reclaim/takeover path is *visible in the trace* (one NDJSON line per
 * sub-phase, OR-19) without inventing states the design does not name.
 * `recovering` similarly carries `bind` as a self-transition: design C1 step
 * 8 binds and publishes strictly *after* `recover`/`classify` (steps 4-5),
 * so both happen while the observable state is still `recovering` — this is
 * exactly what makes "connectable implies fully recovered" hold: a client
 * can only ever observe `serving` once `publish` has fired.
 *
 * No I/O, no ambient clock, no randomness — a plain, total-over-its-legal-
 * pairs function from `(state, event)` to the next state. Every pair this
 * package's own callers can produce is enumerated below; every other pair
 * throws rather than silently returning the input state, so an ordering bug
 * in `acquire.ts`/`compose.ts` fails loudly at the exact call site instead of
 * producing a trace that looks plausible but is wrong.
 */

/** The eight lifecycle states design C9 names. */
export type LifecycleState =
  | "starting"
  | "acquiring"
  | "recovering"
  | "serving"
  | "draining"
  | "stopped"
  | "lost"
  | "refused";

/**
 * Named events driving a transition. `claim`/`probe`/`reclaim`/`takeover`
 * are `acquiring`'s sub-phases; `recover` moves into `recovering`; `bind` is
 * `recovering`'s own sub-phase; `publish` completes the startup path.
 * `lost`/`refused` are legal from any non-terminal state — acquisition (or,
 * for `lost`, the served lifetime) can fail at any sub-phase. `drain`/`stop`
 * cover the served lifetime's graceful shutdown.
 */
export type LifecycleEventKind =
  | "claim"
  | "probe"
  | "reclaim"
  | "takeover"
  | "recover"
  | "bind"
  | "publish"
  | "lost"
  | "refused"
  | "drain"
  | "stop";

export const INITIAL_LIFECYCLE_STATE: LifecycleState = "starting";

const TERMINAL_STATES: ReadonlySet<LifecycleState> = new Set(["stopped", "lost", "refused"]);

export function isTerminalLifecycleState(state: LifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * `(state, event) => next`. Throws `RangeError` on any pair not named below,
 * including any event from a terminal state.
 */
export function transitionLifecycleState(
  current: LifecycleState,
  event: LifecycleEventKind,
): LifecycleState {
  if (isTerminalLifecycleState(current)) {
    throw new RangeError(
      `no transition is legal from the terminal state "${current}" (event "${event}")`,
    );
  }

  // Acquisition, and the served lifetime alike, can fail at any sub-phase —
  // legal from every non-terminal state.
  if (event === "lost") {
    return "lost";
  }
  if (event === "refused") {
    return "refused";
  }

  switch (current) {
    case "starting":
      if (event === "claim") {
        return "acquiring";
      }
      break;

    case "acquiring":
      if (event === "claim" || event === "probe" || event === "reclaim" || event === "takeover") {
        return "acquiring";
      }
      if (event === "recover") {
        return "recovering";
      }
      break;

    case "recovering":
      if (event === "bind") {
        return "recovering";
      }
      if (event === "publish") {
        return "serving";
      }
      break;

    case "serving":
      if (event === "drain") {
        return "draining";
      }
      break;

    case "draining":
      if (event === "stop") {
        return "stopped";
      }
      break;
  }

  throw new RangeError(`illegal lifecycle transition: event "${event}" from state "${current}"`);
}
