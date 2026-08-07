/**
 * SIGTERM/SIGINT handling (design C9, plan Task 5 Step 8). Not a declared
 * port — this is process-level wiring the composition root owns directly,
 * not a seam a pure core is injected through.
 *
 * SIGKILL runs no handler by definition (the kernel never delivers it to
 * userspace code), so there is nothing to register for it. A **second**
 * signal received while already draining escalates to an immediate exit —
 * an operator's second Ctrl-C, or an init system's SIGKILL-follows-SIGTERM
 * escalation arriving as a second SIGTERM under some supervisors, must not
 * be absorbed into "still draining" forever.
 */

export interface SignalHandlerDeps {
  /** Invoked on the first SIGTERM/SIGINT — begin a graceful drain. */
  readonly onDrainRequested: (signal: NodeJS.Signals) => void;
  /** Invoked on a second SIGTERM/SIGINT received while already draining. */
  readonly onForceExit: (signal: NodeJS.Signals) => void;
}

const HANDLED_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

/** Returns an uninstall function so a test (or a graceful re-exec) can remove the handlers it installed. */
export function installSignalHandlers(deps: SignalHandlerDeps): () => void {
  let drainRequested = false;

  const handler = (signal: NodeJS.Signals): void => {
    if (drainRequested) {
      deps.onForceExit(signal);
      return;
    }
    drainRequested = true;
    deps.onDrainRequested(signal);
  };

  for (const signal of HANDLED_SIGNALS) {
    process.on(signal, handler);
  }

  return () => {
    for (const signal of HANDLED_SIGNALS) {
      process.off(signal, handler);
    }
  };
}
