/**
 * The real `LifecycleTraceSink` adapter (design C9/OR-19, plan Task 5 Step
 * 8): one NDJSON line per lifecycle transition, written to stderr —
 * `stdout` stays reserved for any future protocol use, matching this
 * repo's existing NDJSON child convention (design C7's docblock).
 *
 * Tests use an in-memory sink instead (a plain array-backed
 * `LifecycleTraceSink`, assembled inline where needed) rather than a second
 * export here — a fake this thin does not earn a place on the runtime
 * allowlist, and keeping it out of `src/runtime/**` keeps this file's own
 * job to exactly one thing: writing to stderr.
 */

import type { LifecycleTraceEvent, LifecycleTraceSink } from "../ports.js";

export function createStderrTraceSink(): LifecycleTraceSink {
  return {
    emit(event: LifecycleTraceEvent): void {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    },
  };
}
