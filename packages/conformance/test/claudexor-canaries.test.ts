import { describe, expect, it } from "vitest";
import {
  type CancellationFacts,
  classifyCancellation,
  classifyDaemonRestart,
  classifyParentIndependence,
  classifyQuestionAnswer,
  type DaemonRestartFacts,
  type ParentIndependenceFacts,
  type QuestionAnswerFacts,
  toMarkdownTable,
} from "../src/smoke/claudexor/canaries.js";

const TWENTY_MINUTES = 20 * 60_000;

function passingParentFacts(
  overrides: Partial<ParentIndependenceFacts> = {},
): ParentIndependenceFacts {
  return {
    arm: "detached",
    claudexorStateAtKill: "running",
    launcherAliveAfterKill: false,
    daemonAliveAfterKill: true,
    postKillMs: TWENTY_MINUTES + 5_000,
    minimumPostKillMs: TWENTY_MINUTES,
    postKillEventCount: 42,
    terminalReached: true,
    killAtFractionOfBudget: 0.07,
    ...overrides,
  };
}

describe("classifyParentIndependence", () => {
  it("supports the fully satisfied case", () => {
    expect(classifyParentIndependence(passingParentFacts()).outcome).toBe("supported");
  });

  // The defect this pins: measuring `runCreated -> terminal` instead of
  // `kill -> terminal` lets a 20-minute run whose parent died at minute 19:30
  // report 20 minutes of parent independence.
  it("does not pass when the run only survived briefly after the kill", () => {
    const result = classifyParentIndependence(passingParentFacts({ postKillMs: 30_000 }));
    expect(result.outcome).toBe("degraded");
    expect(result.fallback).toMatch(/post-kill duration/);
  });

  // Survival of a process is not the claim; continued progress is. A run that
  // stalls at the kill and later times out must not pass.
  it("does not pass when no events arrive after the kill", () => {
    const result = classifyParentIndependence(passingParentFacts({ postKillEventCount: 0 }));
    expect(result.outcome).toBe("degraded");
    expect(result.fallback).toMatch(/Survival is not progress/);
  });

  it("does not pass when the kill landed late in the budget", () => {
    expect(
      classifyParentIndependence(passingParentFacts({ killAtFractionOfBudget: 0.9 })).outcome,
    ).toBe("degraded");
  });

  it("does not pass when the run was not running at the kill", () => {
    expect(
      classifyParentIndependence(passingParentFacts({ claudexorStateAtKill: "queued" })).outcome,
    ).toBe("degraded");
  });

  it("reports unsupported, with a bounded fallback, when the daemon dies with its parent", () => {
    const result = classifyParentIndependence(
      passingParentFacts({ arm: "non-detached", daemonAliveAfterKill: false }),
    );
    expect(result.outcome).toBe("unsupported");
    expect(result.fallback).toMatch(/own the daemon's lifetime/);
  });

  it("degrades rather than passing when the launcher survived its own SIGKILL", () => {
    expect(
      classifyParentIndependence(passingParentFacts({ launcherAliveAfterKill: true })).outcome,
    ).toBe("degraded");
  });

  // The two arms are reported separately: a detached process survives its
  // parent on POSIX regardless of the engine, so a detached-only result would
  // measure the spawn flags rather than Claudexor.
  it("keeps the arm in the result name so the arms cannot be conflated", () => {
    expect(classifyParentIndependence(passingParentFacts({ arm: "detached" })).name).toContain(
      "detached",
    );
    expect(classifyParentIndependence(passingParentFacts({ arm: "non-detached" })).name).toContain(
      "non-detached",
    );
  });
});

describe("classifyQuestionAnswer", () => {
  const base: QuestionAnswerFacts = {
    questionObserved: true,
    interactionAnswered: true,
    sameRunContinued: true,
    reachedTerminal: true,
    waitedMs: 60_000,
  };

  it("supports the fully satisfied case", () => {
    expect(classifyQuestionAnswer(base).outcome).toBe("supported");
  });

  // Whether a model asks a question is not under our control, so "no question
  // appeared" must be an honest "not exercised", never a pass.
  it("degrades when no question was raised", () => {
    const result = classifyQuestionAnswer({ ...base, questionObserved: false });
    expect(result.outcome).toBe("degraded");
    expect(result.fallback).toMatch(/unverified/);
  });

  it("reports unsupported when the answer did not resume the same run", () => {
    const result = classifyQuestionAnswer({ ...base, sameRunContinued: false });
    expect(result.outcome).toBe("unsupported");
    expect(result.fallback).toMatch(/same worker session/);
  });

  it("never reports supported without an answered interaction", () => {
    expect(classifyQuestionAnswer({ ...base, interactionAnswered: false }).outcome).not.toBe(
      "supported",
    );
  });
});

describe("classifyCancellation", () => {
  const base: CancellationFacts = {
    acceptedControlCall: true,
    finalState: "cancelled",
    survivingDescendantPids: 0,
    settleMs: 3_000,
  };

  it("supports a clean cancel", () => {
    expect(classifyCancellation(base).outcome).toBe("supported");
  });

  it("degrades when the process tree is not reaped", () => {
    const result = classifyCancellation({ ...base, survivingDescendantPids: 2 });
    expect(result.outcome).toBe("degraded");
    expect(result.fallback).toMatch(/reap the process tree/);
  });

  it("degrades when the run settles as something other than cancelled", () => {
    expect(classifyCancellation({ ...base, finalState: "succeeded" }).outcome).toBe("degraded");
  });

  it("reports unsupported when the control call is refused", () => {
    expect(classifyCancellation({ ...base, acceptedControlCall: false }).outcome).toBe(
      "unsupported",
    );
  });
});

describe("classifyDaemonRestart", () => {
  const base: DaemonRestartFacts = {
    daemonRestarted: true,
    runStillReadable: true,
    stateAfterRestart: "interrupted",
    recoveryPartitionReadable: true,
  };

  // §18.2 promises classification of an uncertain attempt, not transparent
  // continuation, so `interrupted` after a restart is a supported outcome.
  it("supports a readable run after restart, including an interrupted one", () => {
    expect(classifyDaemonRestart(base).outcome).toBe("supported");
    expect(classifyDaemonRestart({ ...base, stateAfterRestart: "running" }).outcome).toBe(
      "supported",
    );
  });

  it("reports unsupported when the handle did not survive the restart", () => {
    const result = classifyDaemonRestart({ ...base, runStillReadable: false });
    expect(result.outcome).toBe("unsupported");
    expect(result.fallback).toMatch(/recovery_required/);
  });

  it("degrades when the daemon never came back", () => {
    expect(classifyDaemonRestart({ ...base, daemonRestarted: false }).outcome).toBe("degraded");
  });
});

describe("toMarkdownTable", () => {
  it("renders one row per canary with its evidence", () => {
    const table = toMarkdownTable([
      classifyParentIndependence(passingParentFacts()),
      classifyCancellation({
        acceptedControlCall: true,
        finalState: "cancelled",
        survivingDescendantPids: 0,
        settleMs: 1,
      }),
    ]);
    expect(table.split("\n")).toHaveLength(4);
    expect(table).toContain("parentIndependence(detached)");
    expect(table).toContain("cancellationCleanup");
    expect(table).toContain("postKillMs=");
  });

  // The ADR embeds this table; a newline in a value would break the table and,
  // more importantly, would mean an unsanitised value reached the document.
  it("emits no embedded newlines inside a row", () => {
    const rows = toMarkdownTable([classifyParentIndependence(passingParentFacts())]).split("\n");
    for (const row of rows) expect(row.startsWith("|")).toBe(true);
  });
});
