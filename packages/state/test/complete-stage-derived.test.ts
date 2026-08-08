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
 */
const KNOWN_DISPATCH_VOCABULARY_EXEMPTIONS = new Set(["settleNativeDispatch"]);

describe("§16.6 step 6 is derived, never performed (design D7, plan Task 4.6)", () => {
  it("artifact/complete-stage.ts exports exactly completeStage at runtime — no second, release-shaped export", () => {
    const runtimeExports = Object.keys(completeStageModule);
    expect(runtimeExports).toEqual(["completeStage"]);
  });

  it("no export anywhere in the package barrel is named like a release/dispatch call", () => {
    const suspicious = Object.keys(packageBarrel).filter(
      (name) =>
        RELEASE_OR_DISPATCH_NAME_PATTERN.test(name) &&
        !KNOWN_DISPATCH_VOCABULARY_EXEMPTIONS.has(name),
    );
    expect(suspicious).toEqual([]);
  });

  it("completeStage itself takes no callback/listener parameter a release call could be smuggled through", () => {
    // `completeStage(db, store, input)` — arity 3, no fourth "onReleased"-
    // shaped parameter. `Function.length` counts parameters up to the first
    // one with a default value, which none of these three has.
    expect(completeStageModule.completeStage.length).toBe(3);
  });
});

describe("AC-1's second leg (Phase 4 fix cycle 1, Q2): the package barrel's exact runtime export surface", () => {
  /**
   * AC-1 stands on two legs: the table-keyed guard in `command/commit.ts`
   * (tested elsewhere) AND `commitStateChangeInternal` never being reachable
   * from the public barrel. Only the first leg had a test before this one —
   * the release/dispatch name-pattern check above regex-filters names, so it
   * cannot catch a re-export of an already-named internal entry point like
   * `commitStateChangeInternal`. This test pins the exact runtime key list
   * (`Object.keys`, not a source-text grep — a grep can be fooled by a
   * comment or a renamed local; `Object.keys` cannot, and type-only exports
   * never appear in it, so this list is exactly what a runtime consumer can
   * actually reach) so ANY new export — a second `commitStateChangeInternal`
   * leak or anything else — turns this test red and forces a deliberate,
   * reviewed update rather than a silent surface-area change.
   *
   * Accuracy note (Q2): `package.json`'s `exports` map
   * (`{".": "./src/index.ts"}`) blocks only bare-specifier deep imports. It
   * does NOT block relative traversal — `test/command.test.ts` already
   * imports `commitStateChangeInternal` via `../src/command/commit.js`, and
   * `private: true` + `workspace:*` makes any in-repo consumer a pnpm
   * symlink straight into this package's `src/`. So the barrel is a
   * *convention* enforced by this test, not a structural guarantee enforced
   * by the module resolver — this test is what actually makes "not publicly
   * exported" a falsifiable claim rather than an aspiration.
   */
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
        "ReducerError",
        "SchemaVersionError",
        "StageAssertionFailedError",
        "StateDatabaseCorruptionError",
        "StateStoreError",
        "acceptInteractionAnswer",
        "answerNativeQuestion",
        "applyCapacityAnswer",
        "answerCapacityQuestion",
        "applyEvent",
        "assignAttemptWorkspace",
        "assignBackendExecution",
        "assignNativeAttemptWorkspace",
        "attachParentSession",
        "cancelNativeStage",
        "claimNextExecutionCandidate",
        "cancelQueuedExecutionSchedule",
        "commitStateChange",
        "compareInteractionProjectionToJournal",
        "compareNativeQuestionProjectionToJournal",
        "compareProjectionToReplay",
        "completeExecutionAttempt",
        "completeNativeAttemptArtifactOutcome",
        "completePendingArtifactImports",
        "completeStage",
        "createArtifactStore",
        "createExecutionSchedule",
        "createNativeStage",
        "createStageExecution",
        "currentSchemaVersion",
        "detachParentSession",
        "downgradeNativeAttemptToFailed",
        "eventScope",
        "executionCleanupCounts",
        "findRegisteredExecutionContext",
        "latestSequence",
        "legacyAnswerSubmission",
        "listArtifacts",
        "listInteractionInbox",
        "listNativeQuestionInbox",
        "markArtifactImport",
        "markExecutionFinalized",
        "markExecutionOperationDelivered",
        "migrationManifest",
        "openStateDatabase",
        "pollNativeBridge",
        "projectionDigest",
        "publishArtifact",
        "raiseNativeQuestion",
        "readActiveStageExecutions",
        "readAllRunProjections",
        "readArtifactRecord",
        "readEvents",
        "readEventsForRun",
        "readExecutionAttempts",
        "readCapacityQuestion",
        "readExecutionSchedule",
        "readIdentity",
        "readLatestCapabilitySnapshot",
        "readLegacyPendingInteractions",
        "readNativeStage",
        "readNativeStageAttempts",
        "readPendingExecutionOperations",
        "readPendingInteractions",
        "readPendingNativeQuestions",
        "reapAllExpiredParentSessions",
        "readRecoverableSchedulingAttempts",
        "readRunInteractions",
        "readRunProjection",
        "readSchedulingDecisions",
        "readStageArtifacts",
        "readStageExecution",
        "readWorkspaceLease",
        "recordAttemptReadonlyBaseline",
        "recordExecutionOperationFailure",
        "recordInteractionAnswer",
        "recordNativeAttemptReadonlyBaseline",
        "recordNativeAttemptWorkspaceFailure",
        "recoverArtifacts",
        "renewAccountLease",
        "replacePendingInteractions",
        "replayInteractionEvents",
        "replayJournal",
        "replayNativeQuestionEvents",
        "requestRunResume",
        "restoreAccountLease",
        "resumeNativeStage",
        "runMigrations",
        "schemaFingerprint",
        "settleNativeDispatch",
        "stageArtifactAliasKey",
        "startExecutionAttempt",
        "synchronizePendingInteractions",
        "updateStageExecutionStatus",
        "updateAttemptLimits",
        "writeCapabilitySnapshot",
      ].sort(),
    );
    expect(runtimeExports).not.toContain("commitStateChangeInternal");
  });
});
