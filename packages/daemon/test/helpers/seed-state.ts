/**
 * `seedState` — a real, on-disk `state.sqlite` pre-populated with one run in
 * every non-terminal `RunStatus` (design C12, plan Task 4 Step 5).
 *
 * A real filesystem, never `:memory:` — `openStateDatabase`/`runMigrations`
 * are exercised exactly as `openOwnedStateDatabase` exercises them in
 * production, and an in-memory `journal_mode` would make that exercise
 * vacuous (mirrors `packages/state/test/helpers/temp-db.ts`'s own
 * reasoning). `mkdtemp` against `os.tmpdir()` keeps the directory outside
 * the repository, the same pattern `packages/conformance/src/smoke/claudexor/daemon-handle.ts`
 * and `packages/state/test/helpers/temp-db.ts` already use.
 *
 * Test infrastructure — outside `src/**`, so the determinism gate
 * (`test/no-ambient-sources.test.ts`) does not scan this file — but kept
 * deterministic anyway: `Clock`/`IdGenerator` are always caller-injected,
 * never read from an ambient source here.
 *
 * The seeding connection is closed before this returns: `reconcile.ts`
 * opens its own connection via `openOwnedStateDatabase`, and two live
 * `node:sqlite` connections open at once is exactly the condition
 * `openStateDatabase`'s own docblock calls out as degrading to
 * `SQLITE_BUSY` under contention — pointless to risk when the seeding work
 * is already complete by the time a caller gets this back.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock, IdGenerator } from "@heniek/state";
import { commitStateChange, openStateDatabase, runMigrations } from "@heniek/state";

const TEMP_DIR_PREFIX = "heniek-daemon-recovery-";

/** The five non-terminal `RunStatus` values (`@heniek/contracts`'s `RunStatus.nonTerminal`), spelled out rather than read back from the contract, so a seeded fixture never silently drifts from what this file actually wrote. */
export const NON_TERMINAL_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_on_user",
  "waiting_for_parent_session",
  "recovery_required",
] as const;

export type NonTerminalRunStatus = (typeof NON_TERMINAL_RUN_STATUSES)[number];

export interface SeedStateOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface SeededState {
  /** The mkdtemp root — remove this in `cleanup()`, never before. */
  readonly directory: string;
  /** Absolute path to the migrated `state.sqlite`. */
  readonly databasePath: string;
  /** Not yet created — `createArtifactStore` inside `reconcile()` creates `incoming/`/`blobs/sha256/` under it on first use. */
  readonly artifactStoreRoot: string;
  /** One run id per non-terminal status, keyed by the status it was seeded into. */
  readonly runIds: Readonly<Record<NonTerminalRunStatus, string>>;
  /** Removes the temp directory tree. Call in `afterEach`, always. */
  cleanup(): Promise<void>;
}

const SEED_CODEBASE_ID = "cb-seed";

export async function seedState(options: SeedStateOptions): Promise<SeededState> {
  const directory = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  const databasePath = join(directory, "state.sqlite");
  const artifactStoreRoot = join(directory, "artifacts");

  const db = openStateDatabase({ path: databasePath, clock: options.clock, ids: options.ids });
  try {
    runMigrations(db);

    commitStateChange(db, {
      type: "codebase.registered",
      payload: { codebaseId: SEED_CODEBASE_ID },
    });

    const runIds: Record<string, string> = {};
    for (const status of NON_TERMINAL_RUN_STATUSES) {
      const runId = `run-${status}`;
      commitStateChange(db, {
        runId,
        type: "run.created",
        payload: { runId, codebaseId: SEED_CODEBASE_ID },
      });
      // `run.created` always lands a fresh run in `queued` (the reducer has
      // no other branch) — every other status needs an explicit transition.
      if (status !== "queued") {
        commitStateChange(db, {
          runId,
          type: "run.status_changed",
          payload: { runId, status },
        });
      }
      runIds[status] = runId;
    }

    return {
      directory,
      databasePath,
      artifactStoreRoot,
      runIds: runIds as Record<NonTerminalRunStatus, string>,
      async cleanup(): Promise<void> {
        await rm(directory, { recursive: true, force: true });
      },
    };
  } finally {
    db.close();
  }
}
