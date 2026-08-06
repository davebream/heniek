/**
 * `reconcile` — the restart-reconciliation pass (design C12, plan Task 4
 * Step 8), run once per boot inside `recovering`, strictly before the
 * socket is bound.
 *
 * **Ordered pass — do not reorder** (design C12):
 *
 *   assertStillHeld() -> openStateDatabase -> runMigrations   [all three inside openOwnedStateDatabase]
 *     -> assertStillHeld()
 *     -> recoverArtifacts(store, db)
 *     -> readAllRunProjections filtered to non-terminal
 *     -> for each run: await backend.status(runId) -> classify -> assertStillHeld() -> commit (only if the applied status differs)
 *
 * **Fatal failures (design's Error Handling section, exit 12).** A failure
 * to open/migrate the owned state database, or a failure building the
 * artifact store / running its sweep, releases the claim and throws
 * `RecoveryFailedError`. Because bind happens only after this pass returns,
 * a fatal failure here means the socket was never bound at all — no client
 * can ever have observed the failed instance.
 *
 * **A claim lost mid-pass is a different failure mode, not the one above.**
 * `assertStillHeld()`'s `ClaimLostError` propagates uncaught, with no
 * `release()` call: by the time it fires, a successor already holds the
 * claim, and `release()` would (correctly) refuse to touch an identity it
 * no longer recognises anyway — calling it would be a no-op at best and
 * misleading at worst. Catching it here and continuing would risk a second
 * writer; letting it abort the pass immediately is IR-16's whole point.
 *
 * **Per-run probe failures are never fatal to the pass** (IR-14/IR-16): a
 * `status()` throw classifies that one run `unknown` / `recovery_required`
 * and the loop moves on to the next run. **No stored PID or process handle
 * is ever consulted** — the only evidence this pass admits is what
 * `backend.status()` answers, obtained fresh on every boot.
 *
 * **Bounded probe deadline — deliberately not implemented (DECIDED, plan
 * Task 4 Step 8 note / plan-review round 1 reviewer B, finding MINOR 8).**
 * `ExecutionBackend` carries no deadline in its contract and design C12
 * puts none on `backend.status()`; no `src/runtime/deadline.ts` exists and
 * no `Deadline` port is injected here. **Residual, recorded for ADR 0007:**
 * a wedged `backend.status()` hangs startup before the bind, leaving no
 * socket to query — the daemon fails closed and visibly rather than
 * serving a half-recovered state. If a future issue adds a deadline, a
 * timeout must classify `unknown`, exactly like a throw, so the
 * classification table stays unchanged either way.
 *
 * **Honest residual (OR-8).** Against real stored state, every non-terminal
 * run currently resolves "backend does not know the run" -> `unknown`,
 * because nothing in this repository yet persists a backend-native run id
 * anywhere `run_projection` (`packages/state/src/projection/run.ts:24-33`)
 * or the reducer (`packages/state/src/projection/reducer.ts:32,54`) can
 * read back. `run.runId` — this package's own identifier — is the only
 * value this pass has to offer `backend.status()`; no committed event type
 * carries a distinct backend id to use instead. This is exactly what OR-8
 * asks to be recorded honestly rather than papered over, not a defect in
 * this module.
 */

import type { ExecutionBackend, ExecutionBackendV2, RunRecoveryClass } from "@heniek/contracts";
import { RunStatus } from "@heniek/contracts";
import {
  type ArtifactStoreOptions,
  commitStateChange,
  createArtifactStore,
  type OpenStateDatabaseOptions,
  type RecoverArtifactsReport,
  readAllRunProjections,
  readStageExecution,
  recoverArtifacts,
  type StateDatabase,
} from "@heniek/state";
import type { LockHandle } from "../lifecycle/guard.js";
import { classifyRunRecovery, type RunProbeOutcome, type RunRecoveryDecision } from "./classify.js";
import { RecoveryFailedError } from "./errors.js";
import { openOwnedStateDatabase } from "./open-owned.js";

export interface ReconcileDeps {
  readonly lock: LockHandle;
  readonly backend: ExecutionBackend;
  readonly backendV2?: ExecutionBackendV2;
}

export interface ReconcileOptions {
  readonly database: OpenStateDatabaseOptions;
  readonly artifactStore: ArtifactStoreOptions;
}

/** One run's classification, in the exact shape `RunRecoveryClassification/v1` wants — `runId` plus `classify.ts`'s decision. */
export interface RunRecoveryRecord extends RunRecoveryDecision {
  readonly runId: string;
}

/** Folds into `DaemonStatus/v1`'s `reconciliation` field. */
export interface ReconciliationTally {
  readonly probed: number;
  readonly resumable: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly unknown: number;
}

export interface ReconcileResult {
  /** The opened, migrated, reconciled database handle — left open for the caller to keep serving from. */
  readonly db: StateDatabase;
  readonly reconciliation: ReconciliationTally;
  readonly artifactRecovery: RecoverArtifactsReport;
  readonly classifications: readonly RunRecoveryRecord[];
}

function zeroClassificationCounts(): Record<RunRecoveryClass, number> {
  return { resumable: 0, failed: 0, cancelled: 0, unknown: 0 };
}

export async function reconcile(
  deps: ReconcileDeps,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const { lock, backend } = deps;

  let db: StateDatabase;
  try {
    db = openOwnedStateDatabase(lock, options.database);
  } catch (error) {
    lock.release();
    throw new RecoveryFailedError(
      "failed to open or migrate the owned state database — refusing to serve over unreconciled state",
      { cause: error },
    );
  }

  // Second explicit check (design C12's ordered pass), before artifact
  // recovery ever touches the filesystem.
  lock.assertStillHeld();

  let artifactRecovery: RecoverArtifactsReport;
  try {
    const store = createArtifactStore(options.artifactStore);
    artifactRecovery = recoverArtifacts(store, db);
  } catch (error) {
    lock.release();
    throw new RecoveryFailedError(
      "artifact recovery failed — refusing to serve over unreconciled state",
      { cause: error },
    );
  }

  const nonTerminalRuns = readAllRunProjections(db).filter(
    (run) => !RunStatus.isTerminal(run.status),
  );

  const counts = zeroClassificationCounts();
  const classifications: RunRecoveryRecord[] = [];

  for (const run of nonTerminalRuns) {
    let outcome: RunProbeOutcome;
    try {
      const execution = readStageExecution(db, run.runId);
      const status =
        execution !== undefined &&
        execution.backendExecutionId !== null &&
        deps.backendV2 !== undefined
          ? await deps.backendV2.status(execution.backendExecutionId)
          : execution !== undefined && execution.backendExecutionId === null
            ? "queued"
            : await backend.status(run.runId);
      outcome = { kind: "status", status };
    } catch {
      // Per-run failure — never fatal to the pass (IR-14/IR-16).
      outcome = { kind: "error" };
    }

    const decision = classifyRunRecovery(outcome);
    counts[decision.classification] += 1;
    classifications.push({ runId: run.runId, ...decision });

    // Re-confirmed per run, right before the commit it guards. A claim
    // replaced mid-pass aborts here, before that commit — `ClaimLostError`
    // propagates uncaught (see this module's docblock).
    lock.assertStillHeld();

    if (decision.runStatus !== run.status) {
      commitStateChange(db, {
        runId: run.runId,
        type: "run.status_changed",
        payload: { runId: run.runId, status: decision.runStatus },
      });
    }
  }

  return {
    db,
    reconciliation: { probed: nonTerminalRuns.length, ...counts },
    artifactRecovery,
    classifications,
  };
}
