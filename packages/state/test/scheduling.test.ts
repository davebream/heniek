import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { runMigrations } from "../src/migrations/migrate.js";
import {
  answerCapacityQuestion,
  applyCapacityAnswer,
  cancelQueuedExecutionSchedule,
  claimNextExecutionCandidate,
  completeExecutionAttempt,
  createExecutionSchedule,
  readCapacityQuestion,
  readExecutionAttempts,
  readExecutionSchedule,
  readSchedulingDecisions,
  renewAccountLease,
  restoreAccountLease,
} from "../src/scheduling/store.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function required<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`expected ${description}`);
  return value;
}

function candidate(profileId: string, accountId: string, maxConcurrentRuns = 1) {
  return {
    profileId,
    accountId,
    engine: "claude",
    maxConcurrentRuns,
    profile: { schemaVersion: 2, profileId },
    limits: { maxDurationMs: 60_000 },
    permissions: { workspace: "read-write", identifiers: [] },
  } as const;
}

describe("migration 10 durable account scheduler", () => {
  let db: StateDatabase;
  let directory: string;
  let clock: ReturnType<typeof createFakeClock>;

  beforeEach(async () => {
    const temp = await makeTempDbPath();
    directory = temp.directory;
    clock = createFakeClock();
    db = openStateDatabase({ path: temp.path, clock, ids: createDeterministicIds(21) });
    runMigrations(db);
  });

  afterEach(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  function schedule(
    runId: string,
    options: {
      priority?: number;
      policy?: "queue" | "fallback" | "ask";
      candidates?: readonly ReturnType<typeof candidate>[];
    } = {},
  ) {
    return createExecutionSchedule(db, {
      runId,
      stageId: `stage-${runId}`,
      codebaseId: "codebase-1",
      repositoryId: "repository-1",
      prompt: "Implement the requested change.",
      artifactPath: "artifacts/result.md",
      baseSha: SHA,
      capacityPolicy: options.policy ?? "queue",
      requestedPriority: options.priority ?? 0,
      chain: { schemaVersion: 1, primaryProfileId: "primary", profiles: [] },
      candidates: options.candidates ?? [candidate("primary", "account-a")],
    });
  }

  it("enforces an account cap and releases capacity only at a terminal attempt", () => {
    schedule("run-1");
    schedule("run-2");
    const first = claimNextExecutionCandidate(db, { ownerId: "daemon-a" });
    expect(first?.runId).toBe("run-1");
    expect(claimNextExecutionCandidate(db, { ownerId: "daemon-b" })).toBeUndefined();

    completeExecutionAttempt(db, {
      attemptId: required(first, "first claim").attemptId,
      status: "succeeded",
    });
    expect(claimNextExecutionCandidate(db, { ownerId: "daemon-b" })?.runId).toBe("run-2");
  });

  it("applies a durable account-capacity reduction to already queued work", () => {
    schedule("running", { candidates: [candidate("primary", "account-a", 2)] });
    expect(claimNextExecutionCandidate(db, { ownerId: "daemon" })?.runId).toBe("running");
    schedule("queued", { candidates: [candidate("primary", "account-a", 1)] });
    expect(claimNextExecutionCandidate(db, { ownerId: "daemon" })).toBeUndefined();
  });

  it("allows only one of two database handles to claim the same queue head", () => {
    schedule("run");
    const second = openStateDatabase({
      path: db.path,
      clock,
      ids: createDeterministicIds(22),
    });
    try {
      const claims = [
        claimNextExecutionCandidate(db, { ownerId: "daemon-a" }),
        claimNextExecutionCandidate(second, { ownerId: "daemon-b" }),
      ];
      expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it("keeps FIFO ties and applies deterministic one-minute priority aging", () => {
    schedule("old-low", { priority: 0 });
    clock.advance(9 * 60_000);
    schedule("new-high", { priority: 9 });
    expect(claimNextExecutionCandidate(db, { ownerId: "daemon" })?.runId).toBe("old-low");
  });

  it("keeps independent account queues independent", () => {
    schedule("run-a", { candidates: [candidate("a", "account-a")] });
    schedule("run-b", { candidates: [candidate("b", "account-b")] });
    expect(
      claimNextExecutionCandidate(db, { ownerId: "daemon", accountId: "account-b" })?.runId,
    ).toBe("run-b");
    expect(
      claimNextExecutionCandidate(db, { ownerId: "daemon", accountId: "account-a" })?.runId,
    ).toBe("run-a");
  });

  it("selects the earliest configured fallback whose account queue is claimable", () => {
    schedule("block-primary");
    claimNextExecutionCandidate(db, { ownerId: "daemon" });
    schedule("fallback-run", {
      policy: "fallback",
      candidates: [
        candidate("primary", "account-a"),
        candidate("fallback-1", "account-b"),
        candidate("fallback-2", "account-c"),
      ],
    });
    const claim = claimNextExecutionCandidate(db, { ownerId: "daemon" });
    expect(claim).toMatchObject({
      runId: "fallback-run",
      candidateIndex: 1,
      profileId: "fallback-1",
    });
    expect(readSchedulingDecisions(db, "fallback-run").map((decision) => decision.kind)).toContain(
      "capacity_rejected",
    );
  });

  it("atomically removes sibling queue memberships when one fallback account wins", () => {
    schedule("run", {
      policy: "fallback",
      candidates: [candidate("primary", "account-a"), candidate("fallback", "account-b")],
    });
    const claim = claimNextExecutionCandidate(db, { ownerId: "daemon" });
    expect(claim?.candidateIndex).toBe(0);
    expect(claimNextExecutionCandidate(db, { ownerId: "other" })).toBeUndefined();
    expect(readExecutionAttempts(db, "run")).toHaveLength(1);
  });

  it("uses fencing revisions and only reclaims an expired orphan lease", () => {
    schedule("run-1");
    const first = required(claimNextExecutionCandidate(db, { ownerId: "daemon-a" }), "first claim");
    const renewed = renewAccountLease(db, {
      attemptId: first.attemptId,
      ownerId: "daemon-a",
      fencingRevision: first.fencingRevision,
    });
    expect(renewed.fencingRevision).toBe(2);
    expect(() =>
      renewAccountLease(db, {
        attemptId: first.attemptId,
        ownerId: "daemon-a",
        fencingRevision: 1,
      }),
    ).toThrow(/fenced/);

    schedule("run-2");
    clock.advance(5 * 60_000 + 1);
    expect(claimNextExecutionCandidate(db, { ownerId: "daemon-b" })?.runId).toBe("run-2");
    expect(readSchedulingDecisions(db, "run-1").map((decision) => decision.kind)).toContain(
      "lease_expired",
    );
  });

  it("fences an uncertain attempt without terminalizing or dispatching its fallback", () => {
    schedule("run", {
      policy: "fallback",
      candidates: [candidate("primary", "account-a"), candidate("fallback", "account-b")],
    });
    const claimed = required(claimNextExecutionCandidate(db, { ownerId: "daemon-a" }), "claim");

    const recovered = restoreAccountLease(db, {
      attemptId: claimed.attemptId,
      ownerId: "daemon-b",
      recoveryReasonCode: "backend_status_unconfirmed",
    });
    const attempt = required(readExecutionAttempts(db, "run")[0], "recovery attempt");
    expect(attempt.status).toBe("recovery_required");
    expect(readExecutionSchedule(db, "run")?.state).toBe("running");
    expect(claimNextExecutionCandidate(db, { ownerId: "daemon-c" })).toBeUndefined();
    expect(readSchedulingDecisions(db, "run").at(-1)).toMatchObject({
      kind: "attempt_recovery_required",
      reasonCode: "backend_status_unconfirmed",
    });

    expect(
      restoreAccountLease(db, {
        attemptId: claimed.attemptId,
        ownerId: "daemon-b",
        recoveryReasonCode: "backend_status_unconfirmed",
      }).fencingRevision,
    ).toBeGreaterThan(recovered.fencingRevision);
    expect(readExecutionAttempts(db, "run")).toHaveLength(1);
  });

  it("persists an ask decision and atomically rejects stale or duplicate answers", () => {
    schedule("block-primary");
    claimNextExecutionCandidate(db, { ownerId: "blocker" });
    const created = schedule("run", {
      policy: "ask",
      candidates: [candidate("primary", "account-a"), candidate("fallback", "account-b")],
    });
    expect(created.state).toBe("queued");
    expect(claimNextExecutionCandidate(db, { ownerId: "daemon" })).toBeUndefined();
    const waiting = required(readExecutionSchedule(db, "run"), "waiting schedule");
    expect(waiting.state).toBe("waiting_on_user");
    expect(
      applyCapacityAnswer(db, {
        runId: "run",
        expectedRevision: waiting.revision,
        answer: { action: "fallback", candidateIndex: 1 },
      }),
    ).toBe("accepted");
    expect(
      applyCapacityAnswer(db, {
        runId: "run",
        expectedRevision: waiting.revision,
        answer: { action: "wait" },
      }),
    ).toBe("stale");
    expect(claimNextExecutionCandidate(db, { ownerId: "daemon" })?.candidateIndex).toBe(1);
  });

  it("persists a Q020-shaped capacity approval across restart and applies it locally once", () => {
    schedule("block-primary");
    claimNextExecutionCandidate(db, { ownerId: "blocker" });
    schedule("run", {
      policy: "ask",
      candidates: [candidate("primary", "account-a"), candidate("fallback", "account-b")],
    });
    claimNextExecutionCandidate(db, { ownerId: "daemon" });
    const databasePath = db.path;
    db.close();
    db = openStateDatabase({
      path: databasePath,
      clock,
      ids: createDeterministicIds(23),
    });
    runMigrations(db);
    const question = required(readCapacityQuestion(db, "run"), "capacity question");
    const interaction = question.interaction as {
      questions: readonly { questionId: string }[];
    };
    const questionId = required(interaction.questions[0], "capacity choice").questionId;
    expect(
      answerCapacityQuestion(db, {
        runId: "run",
        interactionId: question.interactionId,
        expectedInteractionRevision: 1,
        answers: [{ questionId, kind: "single_choice", selectedLabels: ["Use fallback 1"] }],
        answeredByKeyId: "key-1",
      }),
    ).toMatchObject({ interactionRevision: 2 });
    expect(() =>
      answerCapacityQuestion(db, {
        runId: "run",
        interactionId: question.interactionId,
        expectedInteractionRevision: 1,
        answers: [{ questionId, kind: "single_choice", selectedLabels: ["Cancel run"] }],
        answeredByKeyId: "key-1",
      }),
    ).toThrow(/stale/);
    expect(readCapacityQuestion(db, "run")?.state).toBe("answered");
    expect(claimNextExecutionCandidate(db, { ownerId: "daemon" })?.candidateIndex).toBe(1);
  });

  it("preserves failed attempt evidence and queues a later candidate only for eligible failure", () => {
    schedule("run", {
      candidates: [candidate("primary", "account-a"), candidate("fallback", "account-b")],
    });
    const first = required(claimNextExecutionCandidate(db, { ownerId: "daemon" }), "primary claim");
    expect(
      completeExecutionAttempt(db, {
        attemptId: first.attemptId,
        status: "failed",
        failure: { class: "provider_throttled", sanitizedMessage: "provider unavailable" },
        fallbackEligible: true,
      }),
    ).toEqual({ requeued: true, exhausted: false });
    const fallback = required(
      claimNextExecutionCandidate(db, { ownerId: "daemon" }),
      "fallback claim",
    );
    expect(fallback.candidateIndex).toBe(1);
    expect(readExecutionAttempts(db, "run")).toHaveLength(2);
    expect(readExecutionAttempts(db, "run")[0]).toMatchObject({
      workspaceId: null,
      status: "failed",
    });
  });

  it("fails closed for an ineligible failure and records terminal chain state", () => {
    schedule("run", {
      candidates: [candidate("primary", "account-a"), candidate("fallback", "account-b")],
    });
    const claim = required(claimNextExecutionCandidate(db, { ownerId: "daemon" }), "claim");
    expect(
      completeExecutionAttempt(db, {
        attemptId: claim.attemptId,
        status: "failed",
        failure: { class: "authentication_failed", sanitizedMessage: "authentication failed" },
        fallbackEligible: false,
      }),
    ).toEqual({ requeued: false, exhausted: false });
    expect(readExecutionSchedule(db, "run")?.state).toBe("terminal");
    expect(claimNextExecutionCandidate(db, { ownerId: "daemon" })).toBeUndefined();
  });

  it("records chain exhaustion after the final eligible failure", () => {
    schedule("run");
    const claim = required(claimNextExecutionCandidate(db, { ownerId: "daemon" }), "claim");
    expect(
      completeExecutionAttempt(db, {
        attemptId: claim.attemptId,
        status: "failed",
        fallbackEligible: true,
      }),
    ).toEqual({ requeued: false, exhausted: true });
    expect(readSchedulingDecisions(db, "run").at(-1)?.kind).toBe("fallback_exhausted");
  });

  it("records queued cancellation as a terminal attempt and keeps decisions immutable", () => {
    schedule("run");
    expect(cancelQueuedExecutionSchedule(db, "run")).toBe(true);
    expect(readExecutionAttempts(db, "run")).toMatchObject([{ status: "cancelled" }]);
    const decision = required(readSchedulingDecisions(db, "run").at(-1), "cancel decision");
    expect(decision.reasonCode).toBe("cancel");
    expect(() =>
      internalHandle(db)
        .prepare("UPDATE scheduling_decision SET reason_code = 'changed' WHERE decision_id = ?")
        .run(decision.decisionId),
    ).toThrow(/immutable/);
  });
});
