import { describe, expect, it } from "vitest";
import {
  type DaemonReadinessProbe,
  isDaemonReady,
  resolveReadiness,
} from "../src/smoke/claudexor/readiness.js";

describe("resolveReadiness", () => {
  it("becomes ready on a healthz 200", () => {
    expect(resolveReadiness([{ source: "healthz", status: 200 }])).toEqual({
      ready: true,
      via: "healthz",
    });
  });

  it("is not ready on a healthz non-200", () => {
    expect(resolveReadiness([{ source: "healthz", status: 503 }]).ready).toBe(false);
  });

  // Regression: the daemon log is NOT truncated by a new daemon, so a stale
  // `control-api listening` line left by a previous process reads as "ready"
  // while nothing is listening. That produced a false ready during this spike.
  // No quantity of log observations, and no content within them, may authorise
  // readiness.
  it("never becomes ready from log lines, however convincing", () => {
    const staleLog: readonly DaemonReadinessProbe[] = [
      { source: "log", line: "[2026-07-31T23:24:25.110Z] claudexord listening on ...sock" },
      { source: "log", line: "[2026-07-31T23:24:25.114Z] claudexor control-api listening on ..." },
      { source: "log", line: "ready" },
    ];
    expect(resolveReadiness(staleLog)).toEqual({ ready: false, via: null });
  });

  it("ignores preceding log noise once a healthz 200 arrives", () => {
    expect(
      resolveReadiness([
        { source: "log", line: "control-api listening" },
        { source: "healthz", status: 200 },
      ]),
    ).toEqual({ ready: true, via: "healthz" });
  });

  it("is not ready with no observations at all", () => {
    expect(resolveReadiness([]).ready).toBe(false);
  });
});

describe("isDaemonReady", () => {
  it("authorises only healthz 200", () => {
    expect(isDaemonReady({ source: "healthz", status: 200 })).toBe(true);
    expect(isDaemonReady({ source: "healthz", status: 500 })).toBe(false);
    expect(isDaemonReady({ source: "log", line: "control-api listening" })).toBe(false);
  });
});
