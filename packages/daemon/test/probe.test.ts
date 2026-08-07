/**
 * The pure probe-verdict classifier (design C2, plan Task 2 Step 4).
 *
 * The classifier is the whole decision content of the probe — the Phase 5
 * adapter only observes. What each verdict *authorises* downstream is what
 * makes the mapping safety-relevant, so these tests are written against that
 * consequence rather than against the mapping in the abstract:
 *
 * - `absent` / `no-listener` let `acquire.ts` unlink the socket path and take
 *   over. Only a socket proven dead may reach them.
 * - `hostile` and `serving` both forbid the unlink, by different routes —
 *   `hostile` refuses (exit 11), `serving` concedes (exit 10).
 */

import { describe, expect, it } from "vitest";
import { classifyProbeOutcome, type ProbeAttemptOutcome } from "../src/lifecycle/probe.js";

/** Every variant of the input union — kept exhaustive on purpose (see the last test). */
const ALL_OUTCOMES: readonly ProbeAttemptOutcome["kind"][] = [
  "connection-refused",
  "socket-absent",
  "connection-denied",
  "hello-accepted",
  "protocol-violation",
];

/** The verdicts that authorise `acquire.ts` to unlink the socket and take over. */
const RECLAIM_AUTHORISING = new Set(["absent", "no-listener"]);

describe("classifyProbeOutcome — the four verdicts", () => {
  it("ECONNREFUSED means the socket is stale, not occupied", () => {
    expect(classifyProbeOutcome({ kind: "connection-refused" })).toBe("no-listener");
  });

  it("ENOENT means nothing is there at all", () => {
    expect(classifyProbeOutcome({ kind: "socket-absent" })).toBe("absent");
  });

  it("EACCES is hostile — a socket we cannot connect to is not a socket we may remove", () => {
    expect(classifyProbeOutcome({ kind: "connection-denied" })).toBe("hostile");
  });

  it("a well-formed hello means a live incumbent", () => {
    expect(classifyProbeOutcome({ kind: "hello-accepted" })).toBe("serving");
  });

  it("anything that answers but does not speak the protocol is hostile", () => {
    expect(classifyProbeOutcome({ kind: "protocol-violation" })).toBe("hostile");
  });
});

describe("classifyProbeOutcome — the collapses the design forbids", () => {
  it("never collapses hostile into no-listener, which would license unlinking a stranger's socket", () => {
    // The concrete hazard: a same-uid actor pre-binds `daemon.sock`. If either
    // hostile outcome degraded to `no-listener`, a starting daemon would treat
    // that socket as stale and remove it.
    for (const kind of ["connection-denied", "protocol-violation"] as const) {
      const verdict = classifyProbeOutcome({ kind });
      expect(verdict).toBe("hostile");
      expect(RECLAIM_AUTHORISING.has(verdict)).toBe(false);
    }
  });

  it("never collapses hostile into serving — the condition is reported, never silently accepted", () => {
    expect(classifyProbeOutcome({ kind: "connection-denied" })).not.toBe("serving");
    expect(classifyProbeOutcome({ kind: "protocol-violation" })).not.toBe("serving");
  });

  it("only a socket proven dead authorises reclaim", () => {
    const authorising = ALL_OUTCOMES.filter((kind) =>
      RECLAIM_AUTHORISING.has(classifyProbeOutcome({ kind })),
    );

    expect(authorising).toEqual(["connection-refused", "socket-absent"]);
  });
});

describe("classifyProbeOutcome — totality", () => {
  it("maps every declared outcome to a verdict, with no undefined fallthrough", () => {
    for (const kind of ALL_OUTCOMES) {
      expect(classifyProbeOutcome({ kind })).toBeDefined();
    }
  });

  it("is a pure function of the outcome kind — repeated calls agree", () => {
    for (const kind of ALL_OUTCOMES) {
      expect(classifyProbeOutcome({ kind })).toBe(classifyProbeOutcome({ kind }));
    }
  });
});
