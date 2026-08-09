/**
 * Bounded-repair recovery decisions: classify → fingerprint → budget → strategy.
 */

import { deriveRecoveryDecisionId } from "../scheduler/ids.js";
import type { PipelineFailurePlain } from "./classify.js";
import { buildFailureSignature, type PipelineFailureSignaturePlain } from "./signature.js";

export interface StageRecoveryCounters {
  repairsUsed: number;
  lastSignatureDigest?: string;
  identicalSignatureCount: number;
  pendingProposalId?: string;
  pendingDirective?: PipelineRetryDirectivePlain;
}

export interface OnValidationFailurePolicy {
  readonly strategy: "pause" | "fail" | "repair" | "repair_fresh" | "delegate";
  readonly session?: "fresh" | "resume";
  readonly maxAttempts?: number;
  readonly delegateTo?: string;
}

export interface DecideRecoveryInput {
  readonly runId: string;
  readonly stageId: string;
  readonly graphRevision: number;
  readonly generation: number;
  readonly attemptOrdinal: number;
  readonly now: string;
  readonly failure: PipelineFailurePlain;
  readonly stageType: string;
  readonly sessionPolicy?: "fresh" | "resume";
  readonly onValidationFailure?: OnValidationFailurePolicy;
  readonly executionMode: "autonomous" | "hitl";
  readonly counters: StageRecoveryCounters;
  readonly repairBudget: number;
  readonly priorAttemptId?: string;
  readonly priorBackendExecutionId?: string;
  readonly resumeAvailable: boolean;
}

export interface PipelineRetryDirectivePlain {
  readonly schemaVersion: 1;
  readonly mode: "fresh" | "resume" | "delegate";
  readonly sessionPolicy: "fresh" | "resume";
  readonly priorAttemptId?: string;
  readonly priorBackendExecutionId?: string;
  readonly delegateTo?: string;
  readonly recoveryContextDigest?: string;
}

export interface PipelineRecoveryDecisionPlain {
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly graphRevision: number;
  readonly generation: number;
  readonly attemptOrdinal: number;
  readonly action: "propose" | "approve" | "reject" | "dispatch" | "block" | "fail" | "exhaust";
  readonly outcome:
    | "pause"
    | "fail"
    | "repair"
    | "repair_fresh"
    | "delegate"
    | "exhausted"
    | "unchanged_exhausted"
    | "rejected"
    | "blocked";
  readonly failure?: PipelineFailurePlain;
  readonly signature?: PipelineFailureSignaturePlain;
  readonly directive?: PipelineRetryDirectivePlain;
  readonly proposalId?: string;
  readonly repairsUsed: number;
  readonly repairBudget: number;
  readonly identicalSignatureCount: number;
  readonly detail?: string;
  readonly recordedAt: string;
}

export type DecideRecoveryResult =
  | {
      readonly kind: "fail";
      readonly reason:
        | "attempt_failed"
        | "repair_exhausted"
        | "unchanged_failure_exhausted"
        | "recovery_rejected";
      readonly recoveryDecision: PipelineRecoveryDecisionPlain;
      readonly nextCounters: StageRecoveryCounters;
    }
  | {
      readonly kind: "block";
      readonly reason: "condition_blocked" | "resume_unavailable" | "pause";
      readonly blockReason: string;
      readonly recoveryDecision: PipelineRecoveryDecisionPlain;
      readonly nextCounters: StageRecoveryCounters;
    }
  | {
      readonly kind: "propose";
      readonly recoveryDecision: PipelineRecoveryDecisionPlain;
      readonly nextCounters: StageRecoveryCounters;
      readonly directive: PipelineRetryDirectivePlain;
    }
  | {
      readonly kind: "retry";
      readonly reason: "retry_scheduled" | "recovery_approved";
      readonly directive: PipelineRetryDirectivePlain;
      readonly recoveryDecision: PipelineRecoveryDecisionPlain;
      readonly nextCounters: StageRecoveryCounters;
    };
function deriveProposalId(input: {
  readonly runId: string;
  readonly graphRevision: number;
  readonly stageId: string;
  readonly generation: number;
  readonly attemptOrdinal: number;
}): string {
  return `prp:${input.runId}:${input.graphRevision}:${input.stageId}:${input.generation}:${input.attemptOrdinal}`;
}

function updateSignatureCounters(
  counters: StageRecoveryCounters,
  digest: string,
): StageRecoveryCounters {
  const identicalSignatureCount =
    counters.lastSignatureDigest === digest ? counters.identicalSignatureCount + 1 : 1;
  return {
    repairsUsed: counters.repairsUsed,
    lastSignatureDigest: digest,
    identicalSignatureCount,
    ...(counters.pendingProposalId !== undefined
      ? { pendingProposalId: counters.pendingProposalId }
      : {}),
    ...(counters.pendingDirective !== undefined
      ? { pendingDirective: counters.pendingDirective }
      : {}),
  };
}

function buildDecision(
  input: DecideRecoveryInput,
  fields: {
    readonly action: PipelineRecoveryDecisionPlain["action"];
    readonly outcome: PipelineRecoveryDecisionPlain["outcome"];
    readonly signature: PipelineFailureSignaturePlain;
    readonly counters: StageRecoveryCounters;
    readonly directive?: PipelineRetryDirectivePlain;
    readonly proposalId?: string;
    readonly detail?: string;
  },
): PipelineRecoveryDecisionPlain {
  const decision: PipelineRecoveryDecisionPlain = {
    schemaVersion: 1,
    decisionId: deriveRecoveryDecisionId({
      runId: input.runId,
      graphRevision: input.graphRevision,
      stageId: input.stageId,
      generation: input.generation,
      attemptOrdinal: input.attemptOrdinal,
      action: fields.action,
    }),
    runId: input.runId,
    stageId: input.stageId,
    graphRevision: input.graphRevision,
    generation: input.generation,
    attemptOrdinal: input.attemptOrdinal,
    action: fields.action,
    outcome: fields.outcome,
    failure: input.failure,
    signature: fields.signature,
    repairsUsed: fields.counters.repairsUsed,
    repairBudget: input.repairBudget,
    identicalSignatureCount: fields.counters.identicalSignatureCount,
    recordedAt: input.now,
  };
  if (fields.directive !== undefined) {
    (decision as { directive?: PipelineRetryDirectivePlain }).directive = fields.directive;
  }
  if (fields.proposalId !== undefined) {
    (decision as { proposalId?: string }).proposalId = fields.proposalId;
  }
  if (fields.detail !== undefined) {
    (decision as { detail?: string }).detail = fields.detail;
  }
  return decision;
}

type StrategyPlan =
  | {
      readonly ok: true;
      readonly outcome: "repair" | "repair_fresh" | "delegate";
      readonly mode: "fresh" | "resume" | "delegate";
      readonly sessionPolicy: "fresh" | "resume";
      readonly delegateTo?: string;
    }
  | { readonly ok: false; readonly result: DecideRecoveryResult };

function planValidationStrategy(
  input: DecideRecoveryInput,
  signature: PipelineFailureSignaturePlain,
  counters: StageRecoveryCounters,
): StrategyPlan {
  const policy = input.onValidationFailure;
  if (policy === undefined) {
    const nextCounters = counters;
    return {
      ok: false,
      result: {
        kind: "fail",
        reason: "attempt_failed",
        recoveryDecision: buildDecision(input, {
          action: "fail",
          outcome: "fail",
          signature,
          counters: nextCounters,
          detail: "missing_on_validation_failure_policy",
        }),
        nextCounters,
      },
    };
  }

  switch (policy.strategy) {
    case "pause": {
      const nextCounters = counters;
      return {
        ok: false,
        result: {
          kind: "block",
          reason: "pause",
          blockReason: "validation_pause",
          recoveryDecision: buildDecision(input, {
            action: "block",
            outcome: "pause",
            signature,
            counters: nextCounters,
            detail: "validation_pause",
          }),
          nextCounters,
        },
      };
    }
    case "fail": {
      const nextCounters = counters;
      return {
        ok: false,
        result: {
          kind: "fail",
          reason: "attempt_failed",
          recoveryDecision: buildDecision(input, {
            action: "fail",
            outcome: "fail",
            signature,
            counters: nextCounters,
          }),
          nextCounters,
        },
      };
    }
    case "repair":
      return {
        ok: true,
        outcome: "repair",
        mode: "resume",
        sessionPolicy: policy.session ?? "resume",
      };
    case "repair_fresh":
      return {
        ok: true,
        outcome: "repair_fresh",
        mode: "fresh",
        sessionPolicy: "fresh",
      };
    case "delegate": {
      if (policy.delegateTo === undefined || policy.delegateTo.length === 0) {
        const nextCounters = counters;
        return {
          ok: false,
          result: {
            kind: "fail",
            reason: "attempt_failed",
            recoveryDecision: buildDecision(input, {
              action: "fail",
              outcome: "fail",
              signature,
              counters: nextCounters,
              detail: "missing_delegate_to",
            }),
            nextCounters,
          },
        };
      }
      return {
        ok: true,
        outcome: "delegate",
        mode: "delegate",
        sessionPolicy: "fresh",
        delegateTo: policy.delegateTo,
      };
    }
  }
}

function planNonValidationStrategy(input: DecideRecoveryInput): {
  readonly outcome: "repair" | "repair_fresh";
  readonly mode: "fresh" | "resume";
  readonly sessionPolicy: "fresh" | "resume";
} {
  if (input.stageType === "agent") {
    const sessionPolicy = input.sessionPolicy ?? "fresh";
    return {
      outcome: sessionPolicy === "resume" ? "repair" : "repair_fresh",
      mode: sessionPolicy === "resume" ? "resume" : "fresh",
      sessionPolicy,
    };
  }
  return { outcome: "repair_fresh", mode: "fresh", sessionPolicy: "fresh" };
}

function buildDirective(
  input: DecideRecoveryInput,
  plan: {
    readonly mode: "fresh" | "resume" | "delegate";
    readonly sessionPolicy: "fresh" | "resume";
    readonly delegateTo?: string;
  },
  signature: PipelineFailureSignaturePlain,
): PipelineRetryDirectivePlain {
  const directive: PipelineRetryDirectivePlain = {
    schemaVersion: 1,
    mode: plan.mode,
    sessionPolicy: plan.sessionPolicy,
    recoveryContextDigest: signature.digest,
  };
  if (plan.mode === "resume") {
    if (input.priorAttemptId !== undefined) {
      (directive as { priorAttemptId?: string }).priorAttemptId = input.priorAttemptId;
    }
    if (input.priorBackendExecutionId !== undefined) {
      (directive as { priorBackendExecutionId?: string }).priorBackendExecutionId =
        input.priorBackendExecutionId;
    }
  }
  if (plan.delegateTo !== undefined) {
    (directive as { delegateTo?: string }).delegateTo = plan.delegateTo;
  }
  return directive;
}

/**
 * Decide the next recovery action for a classified failure. Pure: all budgets,
 * counters, and clocks arrive as inputs.
 */
export function decideRecovery(input: DecideRecoveryInput): DecideRecoveryResult {
  const signature = buildFailureSignature(input.failure);
  const counters = updateSignatureCounters(input.counters, signature.digest);

  if (
    input.failure.category === "security" ||
    input.failure.category === "terminal" ||
    !input.failure.retryable
  ) {
    return {
      kind: "fail",
      reason: "attempt_failed",
      recoveryDecision: buildDecision(input, {
        action: "fail",
        outcome: "fail",
        signature,
        counters,
      }),
      nextCounters: counters,
    };
  }

  if (input.repairBudget === 0 || counters.repairsUsed >= input.repairBudget) {
    return {
      kind: "fail",
      reason: "repair_exhausted",
      recoveryDecision: buildDecision(input, {
        action: "exhaust",
        outcome: "exhausted",
        signature,
        counters,
        detail: "repair_exhausted",
      }),
      nextCounters: counters,
    };
  }

  if (counters.identicalSignatureCount >= input.repairBudget) {
    return {
      kind: "fail",
      reason: "unchanged_failure_exhausted",
      recoveryDecision: buildDecision(input, {
        action: "exhaust",
        outcome: "unchanged_exhausted",
        signature,
        counters,
        detail: "unchanged_failure_exhausted",
      }),
      nextCounters: counters,
    };
  }

  let strategy: {
    readonly outcome: "repair" | "repair_fresh" | "delegate";
    readonly mode: "fresh" | "resume" | "delegate";
    readonly sessionPolicy: "fresh" | "resume";
    readonly delegateTo?: string;
  };

  if (input.failure.category === "validation") {
    const planned = planValidationStrategy(input, signature, counters);
    if (!planned.ok) {
      return planned.result;
    }
    strategy = planned;
  } else {
    strategy = planNonValidationStrategy(input);
  }

  if (strategy.mode === "resume" && !input.resumeAvailable) {
    return {
      kind: "block",
      reason: "resume_unavailable",
      blockReason: "resume_unavailable",
      recoveryDecision: buildDecision(input, {
        action: "block",
        outcome: "blocked",
        signature,
        counters,
        detail: "resume_unavailable",
      }),
      nextCounters: counters,
    };
  }

  const directive = buildDirective(input, strategy, signature);

  if (input.executionMode === "hitl") {
    const proposalId = deriveProposalId({
      runId: input.runId,
      graphRevision: input.graphRevision,
      stageId: input.stageId,
      generation: input.generation,
      attemptOrdinal: input.attemptOrdinal,
    });
    const nextCounters: StageRecoveryCounters = {
      repairsUsed: counters.repairsUsed,
      identicalSignatureCount: counters.identicalSignatureCount,
      pendingProposalId: proposalId,
      pendingDirective: directive,
      ...(counters.lastSignatureDigest !== undefined
        ? { lastSignatureDigest: counters.lastSignatureDigest }
        : {}),
    };
    return {
      kind: "propose",
      directive,
      recoveryDecision: buildDecision(input, {
        action: "propose",
        outcome: strategy.outcome,
        signature,
        counters: nextCounters,
        directive,
        proposalId,
      }),
      nextCounters,
    };
  }

  const nextCounters: StageRecoveryCounters = {
    repairsUsed: counters.repairsUsed + 1,
    identicalSignatureCount: counters.identicalSignatureCount,
    pendingDirective: directive,
    ...(counters.lastSignatureDigest !== undefined
      ? { lastSignatureDigest: counters.lastSignatureDigest }
      : {}),
  };
  return {
    kind: "retry",
    reason: "retry_scheduled",
    directive,
    recoveryDecision: buildDecision(input, {
      action: "dispatch",
      outcome: strategy.outcome,
      signature,
      counters: nextCounters,
      directive,
    }),
    nextCounters,
  };
}
