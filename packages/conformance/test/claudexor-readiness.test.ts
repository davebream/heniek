import { describe, expect, it } from "vitest";
import { type DaemonReadinessProbe, isDaemonReady } from "../src/smoke/claudexor/readiness.js";

const PORT = 47311;

describe("isDaemonReady", () => {
  it("authorises a fresh healthz 200 on the expected port", () => {
    expect(isDaemonReady({ source: "healthz", status: 200, port: PORT, attempt: 1 }, PORT)).toBe(
      true,
    );
  });

  it("does not authorise a non-200", () => {
    expect(isDaemonReady({ source: "healthz", status: 503, port: PORT, attempt: 1 }, PORT)).toBe(
      false,
    );
  });

  // The daemon log is not truncated by a new daemon, so a stale
  // `control-api listening` line reads as ready while nothing is listening.
  // That produced a false ready during this spike.
  it("never authorises readiness from a log line, however convincing", () => {
    const staleLines: readonly DaemonReadinessProbe[] = [
      { source: "log", line: "[2026-07-31T23:24:25.110Z] claudexord listening on ...sock" },
      { source: "log", line: "claudexor control-api listening on http://127.0.0.1:47311" },
      { source: "log", line: "ready" },
    ];
    for (const probe of staleLines) {
      expect(isDaemonReady(probe, PORT)).toBe(false);
    }
  });

  // `/healthz` is unauthenticated and outside `/v2`, so it carries no engine
  // identity: a leftover daemon from a previous canary answers 200 just as
  // happily. Canary 4 restarts the daemon on the same home, so a 200 observed
  // against a different port must not authorise this instance.
  it("does not authorise a 200 observed against a different port", () => {
    expect(isDaemonReady({ source: "healthz", status: 200, port: 47399, attempt: 1 }, PORT)).toBe(
      false,
    );
  });

  // Regression against the shape of the original defect: readiness is decided
  // from ONE latest observation, never from "any probe ever seen", which is
  // how a pre-restart 200 would authorise a post-restart daemon.
  it("takes a single probe rather than a history", () => {
    expect(isDaemonReady.length).toBe(2);
  });
});
