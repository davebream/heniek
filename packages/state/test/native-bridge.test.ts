/**
 * The native bridge store (Q023, ADR 0021). Covers what the migration-level
 * test (`migration-11-native-bridge.test.ts`) cannot: the store's own
 * fencing logic, idempotency, reap-on-read, and the full dispatch lifecycle
 * — as opposed to the raw constraints the DDL enforces regardless of caller.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerNativeQuestion,
  attachParentSession,
  cancelNativeStage,
  commitStateChange,
  compareNativeQuestionProjectionToJournal,
  completeNativeAttemptArtifactOutcome,
  createNativeStage,
  detachParentSession,
  openStateDatabase,
  pollNativeBridge,
  raiseNativeQuestion,
  readNativeStage,
  readNativeStageAttempts,
  readPendingNativeQuestions,
  readRunProjection,
  resumeNativeStage,
  runMigrations,
  type StateDatabase,
  settleNativeDispatch,
  type WitnessClassifier,
} from "../src/index.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const SHA = "e".repeat(40);

/** No wire witness channel exists yet (no plugin) — every real classifier today returns "unknown", which fails closed. Tests that need a controlled verdict override this. */
const UNKNOWN_WITNESS: WitnessClassifier = () => "unknown";
const ALIVE_WITNESS: WitnessClassifier = () => "alive";
const DEAD_WITNESS: WitnessClassifier = () => "dead";

let directory: string;
let db: StateDatabase;
let clock: ReturnType<typeof createFakeClock>;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  clock = createFakeClock();
  db = openStateDatabase({
    path: temp.path,
    clock,
    ids: createDeterministicIds(41),
  });
  runMigrations(db);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function seedIdentity(codebaseId = "codebase-1", repositoryId = "repository-1"): void {
  commitStateChange(db, {
    type: "codebase.registration_committed",
    payload: {
      registration: {
        codebaseId,
        configurationSha256: `${SHA.replace(/e/g, "a")}a`,
        instructionSnapshot: {},
        name: "native-bridge",
        repositories: [
          {
            defaultBranch: "main",
            defaultRemote: "origin",
            gitCommonDirectory: "/managed/nb/.git",
            name: "native-bridge",
            path: "/managed/nb",
            remotes: [],
            repositoryId,
          },
        ],
        rootPath: "/managed/nb",
        topologySha256: `${SHA.replace(/e/g, "b")}a`,
      },
    },
  });
}

function stage(runId: string, overrides: { readonly codebaseId?: string } = {}) {
  return createNativeStage(db, {
    runId,
    stageId: `stage-${runId}`,
    codebaseId: overrides.codebaseId ?? "codebase-1",
    repositoryId: "repository-1",
    profileId: "opus-native",
    profile: { schemaVersion: 2, profileId: "opus-native" },
    permissions: { schemaVersion: 1, workspace: "read-only", identifiers: [] },
    limits: { maxDurationMs: 600_000 },
    prompt: "Do the thing.",
    artifactPath: "out/result.json",
    instructionsPath: "docs/instructions.md",
    artifactContract: "heniek://contract/ExternalStageResult/v1",
    model: "opus",
    effort: "high",
    questions: "parent-mediated",
    baseSha: SHA,
  });
}

function attach(codebaseId = "codebase-1") {
  const outcome = attachParentSession(db, { codebaseId, witnessOf: UNKNOWN_WITNESS });
  if (!outcome.accepted) throw new Error("expected attach to be accepted");
  return outcome;
}

function claimOne(sessionId: string, sessionRevision: number, codebaseId = "codebase-1") {
  const outcome = pollNativeBridge(db, {
    sessionId,
    sessionRevision,
    codebaseId,
    maxDispatches: 4,
    witnessOf: UNKNOWN_WITNESS,
  });
  if (!outcome.accepted) throw new Error("expected poll to be accepted");
  return outcome;
}

/**
 * `PendingInteractionV2.id`/`.questions[].id` are branded (`InteractionId`/
 * `InteractionQuestionId`) — `as never` on the plain string id is the
 * existing repo convention for constructing a branded contract value from a
 * test literal (see e.g. `daemon/test/scheduling-service.test.ts`'s
 * `"backend-q021" as never`). Centralised once here since six call sites
 * would otherwise repeat it.
 */
function nativeInteractionInput(
  id: string,
  prompt = "?",
): {
  schemaVersion: 2;
  id: never;
  questions: {
    id: never;
    prompt: string;
    options: { label: string }[];
    multiSelect: boolean;
  }[];
  requestedAt: string;
} {
  return {
    schemaVersion: 2,
    id: id as never,
    questions: [
      {
        id: "q1" as never,
        prompt,
        options: [{ label: "a" }, { label: "b" }],
        multiSelect: false,
      },
    ],
    requestedAt: "2026-08-08T00:00:00.000Z",
  };
}

describe("Q023 native bridge store — lifecycle", () => {
  it("creates a native stage waiting for a parent, with no live session attached", () => {
    seedIdentity();
    const created = stage("run-1");
    expect(created.state).toBe("waiting_for_parent");
    expect(created.waitingSince).not.toBeNull();
    expect(readRunProjection(db, "run-1")?.status).toBe("waiting_for_parent_session");
  });

  it("runs the full dispatch -> question -> answer -> submit -> complete sequence", () => {
    seedIdentity();
    stage("run-1");
    const session = attach();
    expect(readRunProjection(db, "run-1")?.status).toBe("waiting_for_parent_session");

    const polled = claimOne(session.sessionId, session.sessionRevision);
    expect(polled.claimed).toHaveLength(1);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");
    expect(dispatch.attemptOrdinal).toBe(1);
    expect(readRunProjection(db, "run-1")?.status).toBe("running");
    expect(readNativeStage(db, "run-1")?.state).toBe("dispatched");

    const raised = raiseNativeQuestion(db, {
      sessionId: session.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: "run-1",
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      interaction: nativeInteractionInput("question-1", "Which approach?"),
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(raised.accepted).toBe(true);
    expect(readRunProjection(db, "run-1")?.status).toBe("waiting_on_user");
    expect(readPendingNativeQuestions(db, "run-1")).toHaveLength(1);

    const answered = answerNativeQuestion(db, {
      runId: "run-1",
      submission: {
        schemaVersion: 2,
        interactionId: "question-1" as never,
        expectedInteractionRevision: 1,
        answers: [{ questionId: "q1" as never, kind: "single_choice", selectedLabels: ["a"] }],
      },
      answeredByKeyId: "key-1",
    });
    expect(answered.status).toBe("running");
    expect(readRunProjection(db, "run-1")?.status).toBe("running");
    expect(readPendingNativeQuestions(db, "run-1")).toHaveLength(0);

    // The resume is delivered on the parent's next poll, not pushed.
    const secondPoll = claimOne(session.sessionId, polled.sessionRevision);
    expect(secondPoll.resumes).toHaveLength(1);
    expect(secondPoll.resumes[0]?.interactionId).toBe("question-1");

    const settled = settleNativeDispatch(db, {
      sessionId: session.sessionId,
      sessionRevision: secondPoll.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision + 2, // question raise + answer each bumped it
      runId: "run-1",
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-1",
      submissionDigest: "digest-1",
      outcome: "succeeded",
      declaredSummary: "Done.",
      declaredArtifactPath: "out/result.json",
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(settled).toMatchObject({ accepted: true, requiresArtifactCompletion: true });

    // completeNativeAttemptArtifactOutcome is called only after the daemon
    // service's own finalizeStageArtifact has already moved run_projection
    // to succeeded via completeStage — not exercised at this layer, so the
    // run status here stays whatever it was before this call by design.
    completeNativeAttemptArtifactOutcome(db, { attemptId: dispatch.attemptId, runId: "run-1" });
    expect(readNativeStageAttempts(db, "run-1")).toMatchObject([
      { attemptOrdinal: 1, status: "succeeded" },
    ]);
    expect(readNativeStage(db, "run-1")?.state).toBe("settled");

    expect(compareNativeQuestionProjectionToJournal(db)).toMatchObject({ status: "exact" });
  });

  it("fails a succeeded outcome without an artifact declaration", () => {
    seedIdentity();
    stage("run-1");
    const session = attach();
    const polled = claimOne(session.sessionId, session.sessionRevision);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");

    const settled = settleNativeDispatch(db, {
      sessionId: session.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: "run-1",
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-failed",
      submissionDigest: "digest-failed",
      outcome: "failed",
      failure: {
        schemaVersion: 1,
        classification: "invalid_request",
        phase: "running",
        code: "bad_input",
        message: "The subagent could not proceed.",
        fallbackEligible: false,
      },
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(settled).toMatchObject({ accepted: true, requiresArtifactCompletion: false });
    expect(readRunProjection(db, "run-1")?.status).toBe("failed");
    expect(readNativeStageAttempts(db, "run-1")).toMatchObject([
      { attemptOrdinal: 1, status: "failed" },
    ]);
  });
});

describe("Q023 native bridge store — fencing rejections (D5)", () => {
  it("rejects a poll from an unattached session", () => {
    seedIdentity();
    const outcome = pollNativeBridge(db, {
      sessionId: "session-nonexistent",
      sessionRevision: 1,
      codebaseId: "codebase-1",
      maxDispatches: 1,
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(outcome).toMatchObject({ accepted: false, rejectionCode: "session_not_attached" });
  });

  it("rejects a poll with a stale session revision", () => {
    seedIdentity();
    const session = attach();
    const outcome = pollNativeBridge(db, {
      sessionId: session.sessionId,
      sessionRevision: session.sessionRevision + 5,
      codebaseId: "codebase-1",
      maxDispatches: 1,
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(outcome).toMatchObject({ accepted: false, rejectionCode: "stale_session_revision" });
  });

  it("collapses wrong run, stage, and attempt into the same unknown_dispatch code — never distinguishing existence from ownership", () => {
    seedIdentity();
    stage("run-1");
    const session = attach();
    const polled = claimOne(session.sessionId, session.sessionRevision);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");

    for (const [field, value] of [
      ["runId", "run-other"],
      ["stageId", "stage-other"],
      ["attemptId", "attempt-other"],
    ] as const) {
      const outcome = raiseNativeQuestion(db, {
        sessionId: session.sessionId,
        sessionRevision: polled.sessionRevision,
        dispatchId: dispatch.dispatchId,
        expectedDispatchRevision: dispatch.dispatchRevision,
        runId: "run-1",
        stageId: dispatch.stageId,
        attemptId: dispatch.attemptId,
        [field]: value,
        interaction: nativeInteractionInput(`question-${field}`),
        witnessOf: UNKNOWN_WITNESS,
      });
      expect(outcome, `expected ${field} mismatch to be rejected`).toMatchObject({
        accepted: false,
        rejectionCode: "unknown_dispatch",
      });
    }
    // State is byte-identical to before every rejected attempt: still exactly one, un-mutated dispatch.
    expect(readPendingNativeQuestions(db, "run-1")).toHaveLength(0);
  });

  it("rejects a stale dispatch revision", () => {
    seedIdentity();
    stage("run-1");
    const session = attach();
    const polled = claimOne(session.sessionId, session.sessionRevision);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");

    const outcome = raiseNativeQuestion(db, {
      sessionId: session.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision + 99,
      runId: "run-1",
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      interaction: nativeInteractionInput("question-stale"),
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(outcome).toMatchObject({ accepted: false, rejectionCode: "stale_dispatch_revision" });
  });
});

describe("Q023 native bridge store — idempotent submission (D4)", () => {
  it("returns the recorded outcome on an identical resubmit, settling exactly once", () => {
    seedIdentity();
    stage("run-1");
    const session = attach();
    const polled = claimOne(session.sessionId, session.sessionRevision);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");

    const submitInput = {
      sessionId: session.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: "run-1",
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-once",
      submissionDigest: "digest-once",
      outcome: "failed" as const,
      failure: {
        schemaVersion: 1 as const,
        classification: "invalid_request" as const,
        phase: "running" as const,
        code: "bad_input",
        message: "nope",
        fallbackEligible: false,
      },
      witnessOf: UNKNOWN_WITNESS,
    };

    const first = settleNativeDispatch(db, submitInput);
    expect(first).toMatchObject({ accepted: true, idempotentReplay: false });
    const attemptsAfterFirst = readNativeStageAttempts(db, "run-1");

    const replay = settleNativeDispatch(db, submitInput);
    expect(replay).toMatchObject({ accepted: true, idempotentReplay: true });
    expect(readNativeStageAttempts(db, "run-1")).toEqual(attemptsAfterFirst);
  });

  it("rejects a resubmit with the same submissionId but a different payload digest", () => {
    seedIdentity();
    stage("run-1");
    const session = attach();
    const polled = claimOne(session.sessionId, session.sessionRevision);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");

    const base = {
      sessionId: session.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      runId: "run-1",
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-reused",
      outcome: "failed" as const,
      failure: {
        schemaVersion: 1 as const,
        classification: "invalid_request" as const,
        phase: "running" as const,
        code: "bad_input",
        message: "nope",
        fallbackEligible: false,
      },
      witnessOf: UNKNOWN_WITNESS,
    };

    settleNativeDispatch(db, {
      ...base,
      expectedDispatchRevision: dispatch.dispatchRevision,
      submissionDigest: "digest-a",
    });
    const reused = settleNativeDispatch(db, {
      ...base,
      expectedDispatchRevision: dispatch.dispatchRevision,
      submissionDigest: "digest-b",
    });
    expect(reused).toMatchObject({ accepted: false, rejectionCode: "idempotency_key_reuse" });
  });

  it("rejects a different submissionId against an already-settled dispatch", () => {
    seedIdentity();
    stage("run-1");
    const session = attach();
    const polled = claimOne(session.sessionId, session.sessionRevision);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");

    const base = {
      sessionId: session.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: "run-1",
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      outcome: "failed" as const,
      failure: {
        schemaVersion: 1 as const,
        classification: "invalid_request" as const,
        phase: "running" as const,
        code: "bad_input",
        message: "nope",
        fallbackEligible: false,
      },
      witnessOf: UNKNOWN_WITNESS,
    };

    settleNativeDispatch(db, { ...base, submissionId: "submission-first", submissionDigest: "d1" });
    const second = settleNativeDispatch(db, {
      ...base,
      submissionId: "submission-second",
      submissionDigest: "d2",
    });
    expect(second).toMatchObject({ accepted: false, rejectionCode: "dispatch_already_settled" });
  });
});

describe("Q023 native bridge store — reconnect (rebind)", () => {
  it("rebinding invalidates a pre-rebind submit and moves the open dispatch to the new session", () => {
    seedIdentity();
    stage("run-1");
    const first = attach();
    const polled = claimOne(first.sessionId, first.sessionRevision);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");

    const rebind = attachParentSession(db, {
      codebaseId: "codebase-1",
      previousSessionId: first.sessionId,
      previousSessionRevision: polled.sessionRevision,
      resumeDispatchIds: [dispatch.dispatchId],
      witnessOf: UNKNOWN_WITNESS,
    });
    if (!rebind.accepted) throw new Error("expected rebind to be accepted");
    expect(rebind.resumedDispatchIds).toEqual([dispatch.dispatchId]);
    expect(rebind.supersededSessionId).toBe(first.sessionId);

    // The pre-rebind submit still carries the OLD session id and OLD dispatch revision.
    const staleSubmit = settleNativeDispatch(db, {
      sessionId: first.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: "run-1",
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-stale",
      submissionDigest: "digest-stale",
      outcome: "succeeded",
      declaredSummary: "Stale.",
      declaredArtifactPath: "out/result.json",
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(staleSubmit.accepted).toBe(false);

    // The rebound session, with the bumped revision, succeeds.
    const freshSubmit = settleNativeDispatch(db, {
      sessionId: rebind.sessionId,
      sessionRevision: rebind.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision + 1,
      runId: "run-1",
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-fresh",
      submissionDigest: "digest-fresh",
      outcome: "succeeded",
      declaredSummary: "Fresh.",
      declaredArtifactPath: "out/result.json",
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(freshSubmit).toMatchObject({ accepted: true, requiresArtifactCompletion: true });
  });

  it("rejects a rebind against a stale previous-session revision rather than silently attaching fresh", () => {
    seedIdentity();
    const first = attach();
    const rebind = attachParentSession(db, {
      codebaseId: "codebase-1",
      previousSessionId: first.sessionId,
      previousSessionRevision: first.sessionRevision + 5,
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(rebind).toMatchObject({ accepted: false, rejectionCode: "stale_session_revision" });
  });
});

describe("Q023 native bridge store — detach (CR8)", () => {
  it("treats an uncorroborated not_started as authoritative and redispatches", () => {
    seedIdentity();
    stage("run-1");
    const session = attach();
    const polled = claimOne(session.sessionId, session.sessionRevision);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");

    const detached = detachParentSession(db, {
      sessionId: session.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatches: [{ dispatchId: dispatch.dispatchId, outcome: "not_started" }],
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(detached).toMatchObject({
      accepted: true,
      released: [{ dispatchId: dispatch.dispatchId, disposition: "redispatchable" }],
    });
    expect(readNativeStage(db, "run-1")?.state).toBe("waiting_for_parent");
    expect(readRunProjection(db, "run-1")?.status).toBe("waiting_for_parent_session");
  });

  it("routes to recovery_required when a question was raised, regardless of the client's claim", () => {
    seedIdentity();
    stage("run-1");
    const session = attach();
    const polled = claimOne(session.sessionId, session.sessionRevision);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");

    raiseNativeQuestion(db, {
      sessionId: session.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: "run-1",
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      interaction: nativeInteractionInput("question-evidence"),
      witnessOf: UNKNOWN_WITNESS,
    });

    const detached = detachParentSession(db, {
      sessionId: session.sessionId,
      sessionRevision: polled.sessionRevision,
      // The client falsely claims the dispatch never started.
      dispatches: [{ dispatchId: dispatch.dispatchId, outcome: "not_started" }],
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(detached).toMatchObject({
      accepted: true,
      released: [{ dispatchId: dispatch.dispatchId, disposition: "recovery_required" }],
    });
    expect(readNativeStage(db, "run-1")?.state).toBe("recovery_required");
    expect(readRunProjection(db, "run-1")?.status).toBe("recovery_required");
  });
});

describe("Q023 native bridge store — CR1 regression: expiry cannot be raced by a late rebind", () => {
  it("a session that sleeps past its lease cannot resurrect its abandoned dispatch after an operator resume", () => {
    seedIdentity();
    stage("run-1");
    const originalSession = attach();
    const firstPoll = claimOne(originalSession.sessionId, originalSession.sessionRevision);
    const firstDispatch = firstPoll.claimed[0];
    if (firstDispatch === undefined) throw new Error("expected a claimed dispatch");

    // T1: the parent's process goes away — sleep past the lease TTL. The
    // NEXT mutating call reaps it inline (CR5), classifying it "dead" (CR6).
    clock.advance(200_000);

    // T1: reap runs inline on this poll (dead witness), abandoning the open
    // dispatch and routing the run to recovery_required.
    const reapingPoll = pollNativeBridge(db, {
      sessionId: originalSession.sessionId,
      sessionRevision: firstPoll.sessionRevision,
      codebaseId: "codebase-1",
      maxDispatches: 1,
      witnessOf: DEAD_WITNESS,
    });
    // The session itself is now expired, so this very poll is rejected —
    // but the reap it triggered already abandoned the dispatch and marked
    // recovery_required as a side effect of the SAME call.
    expect(reapingPoll.accepted).toBe(false);
    expect(readRunProjection(db, "run-1")?.status).toBe("recovery_required");

    // T2: operator resumes, and a fresh session claims a NEW attempt.
    const resumed = resumeNativeStage(db, {
      runId: "run-1",
      expectedRunRevision: readRunProjectionRevision(),
    });
    expect(resumed.status).toBe("waiting_for_parent_session");

    const secondSession = attach();
    const secondPoll = claimOne(secondSession.sessionId, secondSession.sessionRevision);
    const secondDispatch = secondPoll.claimed[0];
    if (secondDispatch === undefined) throw new Error("expected a second claimed dispatch");
    expect(secondDispatch.attemptOrdinal).toBe(2);
    expect(secondDispatch.dispatchId).not.toBe(firstDispatch.dispatchId);

    // T3: the ORIGINAL, now-abandoned dispatch can never be submitted
    // against again — not "unlikely", structurally impossible: its state is
    // already terminal ('abandoned'), and native_dispatch is one-shot.
    const staleSubmit = settleNativeDispatch(db, {
      sessionId: originalSession.sessionId,
      sessionRevision: firstPoll.sessionRevision,
      dispatchId: firstDispatch.dispatchId,
      expectedDispatchRevision: firstDispatch.dispatchRevision,
      runId: "run-1",
      stageId: firstDispatch.stageId,
      attemptId: firstDispatch.attemptId,
      submissionId: "submission-late",
      submissionDigest: "digest-late",
      outcome: "succeeded",
      declaredSummary: "Too late.",
      declaredArtifactPath: "out/result.json",
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(staleSubmit.accepted).toBe(false);

    // The second attempt is unaffected and can still be settled normally.
    const freshSubmit = settleNativeDispatch(db, {
      sessionId: secondSession.sessionId,
      sessionRevision: secondPoll.sessionRevision,
      dispatchId: secondDispatch.dispatchId,
      expectedDispatchRevision: secondDispatch.dispatchRevision,
      runId: "run-1",
      stageId: secondDispatch.stageId,
      attemptId: secondDispatch.attemptId,
      submissionId: "submission-second-attempt",
      submissionDigest: "digest-second-attempt",
      outcome: "succeeded",
      declaredSummary: "Done for real.",
      declaredArtifactPath: "out/result.json",
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(freshSubmit).toMatchObject({ accepted: true, requiresArtifactCompletion: true });
  });

  it("does not expire a session whose liveness witness reports alive", () => {
    seedIdentity();
    stage("run-1");
    const session = attach();
    const polled = claimOne(session.sessionId, session.sessionRevision);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");

    clock.advance(200_000);

    // A second, unrelated attach for the same codebase triggers reap-on-read.
    const secondAttempt = attachParentSession(db, {
      codebaseId: "codebase-1",
      witnessOf: ALIVE_WITNESS,
    });
    expect(secondAttempt.accepted).toBe(true);

    // The original dispatch is untouched — CR6's core guarantee.
    expect(readNativeStage(db, "run-1")?.state).toBe("dispatched");
    expect(readRunProjection(db, "run-1")?.status).toBe("running");

    // The original session is merely "stalled", not expired, and can still submit.
    const settled = settleNativeDispatch(db, {
      sessionId: session.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: "run-1",
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-alive",
      submissionDigest: "digest-alive",
      outcome: "succeeded",
      declaredSummary: "Still here.",
      declaredArtifactPath: "out/result.json",
      witnessOf: ALIVE_WITNESS,
    });
    expect(settled).toMatchObject({ accepted: true, requiresArtifactCompletion: true });
  });
});

describe("Q023 native bridge store — cancellation", () => {
  it("cancels an open dispatch and its pending question together", () => {
    seedIdentity();
    stage("run-1");
    const session = attach();
    const polled = claimOne(session.sessionId, session.sessionRevision);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");

    raiseNativeQuestion(db, {
      sessionId: session.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: "run-1",
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      interaction: nativeInteractionInput("question-cancel"),
      witnessOf: UNKNOWN_WITNESS,
    });

    const cancelled = cancelNativeStage(db, "run-1");
    expect(cancelled).toEqual({ status: "cancelled" });
    expect(readRunProjection(db, "run-1")?.status).toBe("cancelled");
    expect(readPendingNativeQuestions(db, "run-1")).toHaveLength(0);
    expect(readNativeStage(db, "run-1")?.state).toBe("settled");
    expect(compareNativeQuestionProjectionToJournal(db)).toMatchObject({ status: "exact" });
  });

  it("cancelling a run with no native stage is a no-op", () => {
    expect(cancelNativeStage(db, "run-absent")).toBeUndefined();
  });

  it("reports the run's actual terminal status when cancelling an already-settled stage, never assuming cancelled", () => {
    seedIdentity();
    stage("run-1");
    const session = attach();
    const polled = claimOne(session.sessionId, session.sessionRevision);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");

    settleNativeDispatch(db, {
      sessionId: session.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: "run-1",
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-already-failed",
      submissionDigest: "digest-already-failed",
      outcome: "failed",
      failure: {
        schemaVersion: 1,
        classification: "invalid_request",
        phase: "running",
        code: "bad_input",
        message: "nope",
        fallbackEligible: false,
      },
      witnessOf: UNKNOWN_WITNESS,
    });
    expect(readRunProjection(db, "run-1")?.status).toBe("failed");

    expect(cancelNativeStage(db, "run-1")).toEqual({ status: "failed" });
    // Cancelling an already-terminal run must not rewrite its outcome.
    expect(readRunProjection(db, "run-1")?.status).toBe("failed");
  });
});

function readRunProjectionRevision(): number {
  const projection = readRunProjection(db, "run-1");
  if (projection === undefined) throw new Error("expected run-1 projection to exist");
  return projection.revision;
}
