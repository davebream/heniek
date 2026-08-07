/**
 * Canary classification.
 *
 * The *decisions* live here as pure functions over recorded facts; the process
 * and network work that gathers those facts lives in `daemon-handle.ts` and
 * `control-client.ts` and is driven by the opt-in suite. That split matters more than
 * usual for this spike: the ADR's conclusions are exactly these classifications,
 * and a classifier that can only be exercised by spending 20 minutes of real
 * Claude session is a classifier that never gets tested. Everything below runs
 * in `pnpm check`.
 *
 * Pure: no network, filesystem, process, or clock access.
 */

export type CanaryOutcome = "supported" | "unsupported" | "degraded";

export type CanaryEvidence = Readonly<Record<string, string | number | boolean | null>>;

export interface CanaryResult {
  readonly name: string;
  readonly outcome: CanaryOutcome;
  readonly evidence: CanaryEvidence;
  /** Bounded fallback to record in the ADR when the behaviour is not supported. */
  readonly fallback?: string;
}

/** Observations canary 1 gathers around the parent kill. */
export interface ParentIndependenceFacts {
  /** `detached` or `non-detached` — reported separately, never merged. */
  readonly arm: "detached" | "non-detached";
  readonly claudexorStateAtKill: string;
  readonly launcherAliveAfterKill: boolean;
  readonly daemonAliveAfterKill: boolean;
  /** Milliseconds from the kill to the run's terminal state (or to giving up). */
  readonly postKillMs: number;
  readonly minimumPostKillMs: number;
  /** Events with strictly increasing `seq` observed AFTER the kill. */
  readonly postKillEventCount: number;
  readonly terminalReached: boolean;
  /** Fraction of the run budget already elapsed when the kill landed. */
  readonly killAtFractionOfBudget: number;
}

/**
 * Classify parent independence.
 *
 * Three things make this stricter than "the daemon is still alive":
 *
 *  - The measured interval is `terminal - kill`, not `runCreated - terminal`.
 *    A 20-minute run whose parent is killed at minute 19:30 demonstrates 30
 *    seconds of independence, and the issue asks for a >=20-minute session
 *    *and* a parent kill — a conjunction.
 *  - Continued **progress** is required, not mere survival. A run that stalls
 *    the instant its launcher dies and later times out must not pass.
 *  - The kill must land early in the budget, or the first condition is
 *    satisfiable by waiting rather than by the engine doing anything.
 */
export function classifyParentIndependence(facts: ParentIndependenceFacts): CanaryResult {
  const evidence: CanaryEvidence = {
    arm: facts.arm,
    claudexorStateAtKill: facts.claudexorStateAtKill,
    launcherAliveAfterKill: facts.launcherAliveAfterKill,
    daemonAliveAfterKill: facts.daemonAliveAfterKill,
    postKillMs: facts.postKillMs,
    minimumPostKillMs: facts.minimumPostKillMs,
    postKillEventCount: facts.postKillEventCount,
    terminalReached: facts.terminalReached,
    killAtFractionOfBudget: facts.killAtFractionOfBudget,
  };

  if (facts.launcherAliveAfterKill) {
    return {
      name: `parentIndependence(${facts.arm})`,
      outcome: "degraded",
      evidence,
      fallback:
        "The launcher outlived its own SIGKILL, so nothing about parent independence was observed; re-run.",
    };
  }
  if (!facts.daemonAliveAfterKill) {
    return {
      name: `parentIndependence(${facts.arm})`,
      outcome: "unsupported",
      evidence,
      fallback:
        "The daemon died with its launcher. Heniek must own the daemon's lifetime itself (supervised start, not a child of the calling session) and must mark in-flight attempts recovery_required on reconnect.",
    };
  }
  if (facts.claudexorStateAtKill !== "running") {
    return {
      name: `parentIndependence(${facts.arm})`,
      outcome: "degraded",
      evidence,
      fallback: `The run was ${facts.claudexorStateAtKill}, not running, when the parent was killed; the observation says nothing about a live run.`,
    };
  }
  if (facts.killAtFractionOfBudget > 0.2) {
    return {
      name: `parentIndependence(${facts.arm})`,
      outcome: "degraded",
      evidence,
      fallback:
        "The kill landed too late in the run budget to distinguish independence from waiting.",
    };
  }
  if (facts.postKillEventCount <= 0) {
    return {
      name: `parentIndependence(${facts.arm})`,
      outcome: "degraded",
      evidence,
      fallback:
        "The daemon survived but produced no further events, so the run may have stalled at the kill. Survival is not progress.",
    };
  }
  if (facts.postKillMs < facts.minimumPostKillMs) {
    return {
      name: `parentIndependence(${facts.arm})`,
      outcome: "degraded",
      evidence,
      fallback:
        "The run terminated before the required post-kill duration; re-run with a longer-working prompt.",
    };
  }
  return { name: `parentIndependence(${facts.arm})`, outcome: "supported", evidence };
}

/** Observations canary 2 gathers around a question and its answer. */
export interface QuestionAnswerFacts {
  readonly questionObserved: boolean;
  readonly interactionAnswered: boolean;
  /** Did the SAME run continue, rather than a new run being created? */
  readonly sameRunContinued: boolean;
  readonly reachedTerminal: boolean;
  readonly waitedMs: number;
}

/**
 * Classify durable questions and same-session resume.
 *
 * Whether a model asks a question is not under our control, so "no question
 * appeared" is `degraded` — an honest "not exercised" — and never a pass.
 */
export function classifyQuestionAnswer(facts: QuestionAnswerFacts): CanaryResult {
  const evidence: CanaryEvidence = {
    questionObserved: facts.questionObserved,
    interactionAnswered: facts.interactionAnswered,
    sameRunContinued: facts.sameRunContinued,
    reachedTerminal: facts.reachedTerminal,
    waitedMs: facts.waitedMs,
  };
  if (!facts.questionObserved) {
    return {
      name: "questionAnswerResume",
      outcome: "degraded",
      evidence,
      fallback:
        "No question was raised within the budget, so the interaction API was not exercised under a live question. The ADR must record this as unverified rather than as support.",
    };
  }
  if (!facts.interactionAnswered) {
    return {
      name: "questionAnswerResume",
      outcome: "unsupported",
      evidence,
      fallback:
        "A question was observed but could not be answered through /v2; Heniek would need its own inbox and a re-dispatch path.",
    };
  }
  if (!facts.sameRunContinued) {
    return {
      name: "questionAnswerResume",
      outcome: "unsupported",
      evidence,
      fallback:
        "The answer did not resume the same run, so §17.2's 'answer sent to the same worker session' cannot be honoured directly; Heniek must model continuation as a new attempt linked to the original.",
    };
  }
  return {
    name: "questionAnswerResume",
    outcome: facts.reachedTerminal ? "supported" : "degraded",
    evidence,
  };
}

/** Observations canary 3 gathers around cancellation. */
export interface CancellationFacts {
  readonly acceptedControlCall: boolean;
  readonly finalState: string;
  readonly survivingDescendantPids: number;
  readonly settleMs: number;
}

/** Classify cancellation and process-tree cleanup. */
export function classifyCancellation(facts: CancellationFacts): CanaryResult {
  const evidence: CanaryEvidence = {
    acceptedControlCall: facts.acceptedControlCall,
    finalState: facts.finalState,
    survivingDescendantPids: facts.survivingDescendantPids,
    settleMs: facts.settleMs,
  };
  if (!facts.acceptedControlCall) {
    return {
      name: "cancellationCleanup",
      outcome: "unsupported",
      evidence,
      fallback:
        "The control endpoint refused the cancel; Heniek must fall back to terminating the process tree itself.",
    };
  }
  if (facts.finalState !== "cancelled") {
    return {
      name: "cancellationCleanup",
      outcome: "degraded",
      evidence,
      fallback: `Cancel was accepted but the run settled as ${facts.finalState}; Heniek must treat a cancel acknowledgement as a request, not a guarantee.`,
    };
  }
  if (facts.survivingDescendantPids > 0) {
    return {
      name: "cancellationCleanup",
      outcome: "degraded",
      evidence,
      fallback:
        "The run cancelled but left descendant processes; Heniek must reap the process tree itself rather than trusting the engine's cleanup.",
    };
  }
  return { name: "cancellationCleanup", outcome: "supported", evidence };
}

/** Observations canary 4 gathers across a daemon restart. */
export interface DaemonRestartFacts {
  readonly daemonRestarted: boolean;
  readonly runStillReadable: boolean;
  /** Claudexor lifecycle state observed AFTER the restart. */
  readonly stateAfterRestart: string;
  readonly recoveryPartitionReadable: boolean;
}

/**
 * Classify the restart boundary.
 *
 * §18.2 does not promise transparent continuation — it promises that an
 * uncertain attempt is *classified* rather than silently retried. So a run
 * that comes back as `interrupted` is a **supported** outcome here, and it is
 * also the observation that decides whether `interrupted -> recovery_required`
 * is the right mapping.
 */
export function classifyDaemonRestart(facts: DaemonRestartFacts): CanaryResult {
  const evidence: CanaryEvidence = {
    daemonRestarted: facts.daemonRestarted,
    runStillReadable: facts.runStillReadable,
    stateAfterRestart: facts.stateAfterRestart,
    recoveryPartitionReadable: facts.recoveryPartitionReadable,
  };
  if (!facts.daemonRestarted) {
    return {
      name: "daemonRestartRecovery",
      outcome: "degraded",
      evidence,
      fallback: "The daemon did not come back, so the restart boundary was not observed.",
    };
  }
  if (!facts.runStillReadable) {
    return {
      name: "daemonRestartRecovery",
      outcome: "unsupported",
      evidence,
      fallback:
        "The run handle did not survive a daemon restart, so Heniek cannot rely on /v2 for durable state across restarts and must persist its own attempt records and mark them recovery_required.",
    };
  }
  return { name: "daemonRestartRecovery", outcome: "supported", evidence };
}

/** Render canary results as the ADR's observation table. */
export function toMarkdownTable(results: readonly CanaryResult[]): string {
  const lines = ["| canary | outcome | evidence |", "| --- | --- | --- |"];
  for (const result of results) {
    const evidence = Object.entries(result.evidence)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("; ");
    lines.push(`| ${result.name} | ${result.outcome} | ${evidence} |`);
  }
  return lines.join("\n");
}
