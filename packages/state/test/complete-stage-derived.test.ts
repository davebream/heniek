/**
 * §16.6 step 6 ("release dependants") is DERIVED, never performed (design
 * D7; plan Task 4.6). There is no stage lifecycle to release into yet — this
 * package ships no dispatch/release call at all, so a later issue cannot
 * silently reintroduce a post-commit dispatcher without a visible new
 * export appearing here.
 *
 * Asserts against the actual runtime export surface (`Object.keys` of the
 * imported module namespace), not a source-text grep: a grep can be fooled
 * by a comment or a renamed local; a runtime export list cannot.
 */

import { describe, expect, it } from "vitest";
import * as completeStageModule from "../src/artifact/complete-stage.js";
import * as packageBarrel from "../src/index.js";

/** Matches any plausible "release/dispatch dependants" naming a future issue might reach for. */
const RELEASE_OR_DISPATCH_NAME_PATTERN = /release|dispatch|unblock|notify/i;

/**
 * Q023's native bridge introduced a legitimate, unrelated domain noun this
 * package never had before: a "dispatch" is one handover of a native stage
 * to an attached parent session (see `native-bridge/store.ts`'s own header),
 * with no connection to §16.6's "release stage dependants" concept this
 * test otherwise guards. Every export here was reviewed at the time it was
 * added; a name landing here is not a silent exemption; a new export that
 * merely happens to trip the pattern still fails below and must be added
 * explicitly, same as before.
 *
 * Q026's `claimRunnerDispatch` is the same kind of exemption: it claims a
 * scheduler outbox intent for a pipeline stage runner, not §16.6 dependant
 * release.
 */
const KNOWN_DISPATCH_VOCABULARY_EXEMPTIONS = new Set([
  "settleNativeDispatch",
  "claimRunnerDispatch",
]);

describe("§16.6 step 6 is derived, never performed (design D7, plan Task 4.6)", () => {
  it("artifact/complete-stage.ts exports exactly completeStage at runtime — no second, release-shaped export", () => {
    const runtimeExports = Object.keys(completeStageModule);
    expect(runtimeExports).toEqual(["completeStage"]);
  });

  it("Object.keys(barrel) is exactly this pinned list — commitStateChangeInternal is not in it", () => {
    const runtimeExports = Object.keys(packageBarrel).sort();
    expect(runtimeExports).toEqual(
      [
        "ArtifactCountExceededError",
        "ArtifactDigestMismatchError",
        "ArtifactQuarantinedError",
        "ArtifactRecoveryError",
        "ArtifactValidationError",
        "CausalityViolationError",
        "EMPTY_PROJECTION_STATE",
        "InsecureStateDatabaseError",
        "MIGRATIONS",
        "MigrationError",
        "PayloadTooLargeError",
        "PipelineSchedulerConflictError",
        "ReducerError",
        "SchemaVersionError",
        "StageAssertionFailedError",
        "StateDatabaseCorruptionError",
        "StateStoreError",
        "TaskRevisionPatchError",
        "TaskSourceConflictError",
        "TaskSourceInputError",
        "acceptInteractionAnswer",
        "answerCapacityQuestion",
        "answerNativeQuestion",
        "appendRunnerExternalObservation",
        "appendRunnerReconciliationTrace",
        "applyCapacityAnswer",
        "applyEvent",
        "applyPipelineSchedulerPlan",
        "applyTaskRevisionPatch",
        "assignAttemptWorkspace",
        "assignBackendExecution",
        "assignNativeAttemptWorkspace",
        "attachAdHocStage",
        "attachParentSession",
        "cancelNativeStage",
        "cancelQueuedExecutionSchedule",
        "claimNextExecutionCandidate",
        "claimRunnerDispatch",
        "commitStateChange",
        "compareInteractionProjectionToJournal",
        "compareNativeQuestionProjectionToJournal",
        "compareProjectionToReplay",
        "completeExecutionAttempt",
        "completeNativeAttemptArtifactOutcome",
        "completePendingArtifactImports",
        "completeStage",
        "createArtifactStore",
        "createWorkspaceVariantStateStore",
        "createExecutionSchedule",
        "createNativeStage",
        "createPipelineSchedule",
        "createStageExecution",
        "createTaskIngestionSource",
        "createTaskSourceStateStore",
        "currentSchemaVersion",
        "detachParentSession",
        "downgradeNativeAttemptToFailed",
        "eventScope",
        "executionCleanupCounts",
        "exportRunnerAttempt",
        "finalizeRunnerAttempt",
        "findRegisteredExecutionContext",
        "insertContinuationCapsule",
        "insertExecutionSegment",
        "insertFusionDecision",
        "insertIncomingVerification",
        "insertPressureObservation",
        "insertRecoveryDecision",
        "insertRetryDirective",
        "latestSequence",
        "legacyAnswerSubmission",
        "listArtifacts",
        "listContinuationCapsules",
        "listExecutionSegments",
        "listFusionDecisions",
        "listIncomingVerifications",
        "listInteractionInbox",
        "listNativeQuestionInbox",
        "listPipelineApprovalInbox",
        "listPressureObservations",
        "listRecoveryDecisions",
        "listRunFindings",
        "listRunnerExternalObservations",
        "listRunnerReconciliationTraces",
        "listStageRecoveryStates",
        "loadPipelineSchedulerInputParts",
        "markArtifactImport",
        "markExecutionFinalized",
        "markExecutionOperationDelivered",
        "markPipelineSchedulerIntentDelivered",
        "migrationManifest",
        "openStateDatabase",
        "patchExecutionSegment",
        "persistRunnerOperationRequest",
        "pollNativeBridge",
        "projectionDigest",
        "publishArtifact",
        "raiseNativeQuestion",
        "readActiveStageExecutions",
        "readAllRunProjections",
        "readArtifactRecord",
        "readCanonicalRunState",
        "readCapacityQuestion",
        "readContinuationCapsule",
        "readEvents",
        "readEventsForRun",
        "readExecutionAttempts",
        "readExecutionSchedule",
        "readExecutionSegment",
        "readIdentity",
        "readLatestCapabilitySnapshot",
        "readLegacyPendingInteractions",
        "readNativeStage",
        "readNativeStageAttempts",
        "readOpenExecutionSegment",
        "readOpenRunnerAttempts",
        "readParentSession",
        "readPendingEvaluatorEdgeKeys",
        "readPendingExecutionOperations",
        "readPendingInteractions",
        "readPendingNativeQuestions",
        "readPendingPipelineObservations",
        "readPendingPipelineSchedulerIntents",
        "readPipelineAttachment",
        "readPipelineEvaluatorDecisions",
        "readPipelineGraph",
        "readPipelineRunSnapshot",
        "readPipelineSchedule",
        "readPipelineSchedulerDecisions",
        "readPipelineSchedulerIntents",
        "readPipelineStageProjections",
        "readRecoverableSchedulingAttempts",
        "readRetryDirective",
        "readRunInteractions",
        "readRunProjection",
        "readRunnerApprovalAnswer",
        "readRunnerAttempt",
        "readRunnerAttemptByIntent",
        "readRunnerExternalObservation",
        "readRunnerOperationRequest",
        "readRunnerOperationRequestByAttempt",
        "readRunnerOperationState",
        "readRunnerReconciliationTrace",
        "readSchedulingDecisions",
        "readSegmentMetrics",
        "readStageArtifacts",
        "readStageExecution",
        "readStageRecoveryState",
        "readWorkspaceLease",
        "reapAllExpiredParentSessions",
        "rebuildFindingProjection",
        "reconstructRunnerOperation",
        "recordAttemptReadonlyBaseline",
        "recordColdStartSession",
        "recordExecutionOperationFailure",
        "recordFindingReport",
        "recordFusedStage",
        "recordInteractionAnswer",
        "recordNativeAttemptReadonlyBaseline",
        "recordNativeAttemptWorkspaceFailure",
        "recordPipelineObservation",
        "recordRecoveryApproval",
        "recordRunnerApprovalAnswer",
        "recordSmartContinuation",
        "recoverArtifacts",
        "renewAccountLease",
        "replacePendingInteractions",
        "replayInteractionEvents",
        "replayJournal",
        "replayNativeQuestionEvents",
        "reportRunnerCleanupHealth",
        "requestRunResume",
        "restoreAccountLease",
        "resumeNativeStage",
        "runMigrations",
        "schemaFingerprint",
        "settleNativeDispatch",
        "stageArtifactAliasKey",
        "startExecutionAttempt",
        "synchronizePendingInteractions",
        "toSchedulerObservations",
        "updateAttemptLimits",
        "updateExecutionSegment",
        "updateRunnerAttempt",
        "updateRunnerOperationState",
        "updateStageExecutionStatus",
        "upsertCanonicalRunState",
        "upsertSegmentMetrics",
        "upsertStageRecoveryState",
        "validateFindingReportIngestion",
        "writeCapabilitySnapshot",
        "writeContinuationCapsule",
        "writeExecutionSegment",
        "writeFusionDecision",
        "writeIncomingVerification",
        "writePipelineRunSnapshot",
        "writePressureObservation",
      ].sort(),
    );
    expect(runtimeExports).not.toContain("commitStateChangeInternal");
  });

  it("no export name suggests a release/dispatch of dependants (beyond known exemptions)", () => {
    const offenders = Object.keys(packageBarrel).filter(
      (name) =>
        RELEASE_OR_DISPATCH_NAME_PATTERN.test(name) &&
        !KNOWN_DISPATCH_VOCABULARY_EXEMPTIONS.has(name),
    );
    expect(offenders).toEqual([]);
  });
});
