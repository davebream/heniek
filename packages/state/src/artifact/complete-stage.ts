/**
 * `completeStage` — §16.6 steps 4–6, executed as **one** SQLite transaction
 * (plan Task 4.4; design D4). Step 4 (append the stage-result event) and
 * step 5 (update the projection: an `artifact` row per published ref plus
 * the `stage_artifact_alias` row that re-points that name) run through
 * `commitStateChangeInternal`. Step 6 — release dependants — is **derived,
 * never performed** (design D7): there is no stage lifecycle to release
 * into yet, so this module ships no dispatch/release call at all. See
 * `test/complete-stage-derived.test.ts` for the assertion that no such call
 * is exported from this module or the package barrel.
 *
 * This is the only production caller of `commitStateChangeInternal` — every
 * other caller reaches this package through the plain `commitStateChange`,
 * which cannot write `artifact`/`stage_artifact_alias` at all (AC-1,
 * `command/commit.ts`'s `assertGuardedWritesAreVerified`).
 */

import { join } from "node:path";
import {
  type CommitReport,
  commitStateChangeInternal,
  type StageArtifactAssertion,
} from "../command/commit.js";
import type { StateDatabase } from "../database/open.js";
import { StageAssertionFailedError } from "../errors.js";
import type { CausationEventId } from "../journal/event.js";
import type { JsonValue } from "../json.js";
import type { ArtifactFileSystem } from "./file-system.js";
import type { ArtifactPublicationReceipt } from "./publish.js";
import { type ArtifactStore, internalArtifactFileSystem } from "./store.js";

/**
 * One published artifact `completeStage` will fold into the `stage.completed`
 * payload and alias. `receipt` is `publishArtifact`'s own output — the same
 * fd the validated bytes were written through (S1); `completeStage` takes
 * ownership of that fd and closes it (see this module's docblock and the
 * `finally` in `completeStage` below).
 */
export interface CompleteStageArtifactInput {
  readonly receipt: ArtifactPublicationReceipt;
  readonly name: string;
  readonly mediaType: string;
  readonly contentSchemaId: string;
  readonly producer: string;
  readonly sourceLineage: readonly string[];
}

export interface CompleteStageInput {
  readonly runId: string;
  readonly stageId: string;
  /** May be empty — a stage that legitimately produces no outputs must be able to complete (F8). */
  readonly artifacts: readonly CompleteStageArtifactInput[];
  /** Absent ⇒ this event roots a new causal chain and mints a correlation id. */
  readonly causationEventId?: CausationEventId;
}

function closeQuietly(fs: ArtifactFileSystem, fd: number): void {
  try {
    fs.close(fd);
  } catch {
    // Best-effort, mirroring `publish.ts`'s identical helper: the fd may
    // already be invalid on a failure path, and there is nothing further to
    // do about a close failure here.
  }
}

/**
 * S2 — the under-lock assertion. Re-verifies that `artifact.receipt` still
 * names the exact bytes `publishArtifact` validated, using only the
 * receipt's own **pinned** fd (S1 — never a re-open) plus one `lstat` of the
 * blob path.
 *
 * - `fstat(fd)` must report a regular file (never a directory).
 * - `nlink >= 1`, **never `=== 1`** — a crashed publisher's `incoming/`
 *   residue is legitimately a second hard link to a committed blob
 *   (`nlink === 2`); `=== 1` would put AC-1 in direct conflict with AC-3.
 *   Only a full unlink (`nlink === 0`) is refused.
 * - `size` must equal the byte length `publishArtifact` measured.
 * - `lstat` of `<store.root>/<relativePath>` must resolve to the **same**
 *   `ino`/`dev` as the pinned fd — the name→inode binding that proves the
 *   blob path still names the exact file the fd was validated against, not
 *   merely a same-sized file at that address.
 */
function assertArtifactStillValid(
  fs: ArtifactFileSystem,
  store: ArtifactStore,
  artifact: CompleteStageArtifactInput,
): void {
  const { relativePath, byteLength, fd } = artifact.receipt;
  const fdStat = fs.fstat(fd);
  if (fdStat.isDirectory) {
    throw new StageAssertionFailedError(
      relativePath,
      "the pinned fd no longer names a regular file",
    );
  }
  if (fdStat.nlink < 1) {
    throw new StageAssertionFailedError(relativePath, `nlink was ${fdStat.nlink}, expected >= 1`);
  }
  if (fdStat.size !== byteLength) {
    throw new StageAssertionFailedError(
      relativePath,
      `size ${fdStat.size} does not match the published byteLength ${byteLength}`,
    );
  }
  const pathStat = fs.lstat(join(store.root, relativePath));
  if (pathStat.ino !== fdStat.ino || pathStat.dev !== fdStat.dev) {
    throw new StageAssertionFailedError(
      relativePath,
      "the blob path no longer names the inode the validated bytes were written to",
    );
  }
}

/**
 * §16.6 steps 4–6 as one transaction. Appends the `stage.completed` event,
 * writes an `artifact` row per ref (or idempotently adopts an already
 * -identical one, F2) plus the active `stage_artifact_alias` row, and
 * re-verifies every referenced artifact under the write lock (S2) before
 * `COMMIT`.
 *
 * `db` and `store` must share the same root — this function does not verify
 * that itself (it has no way to), but a receipt from a different store's
 * `publishArtifact` call would fail the S2 `lstat` check as soon as the
 * paths diverge.
 *
 * **FD ownership.** `completeStage` owns every `artifact.receipt.fd` it was
 * handed and closes each one in a `finally`, regardless of success or
 * failure — `commit.ts`'s own catch block has no `finally`, so leaving
 * these fds to it would leak one per artifact on every failure path.
 */
export function completeStage(
  db: StateDatabase,
  store: ArtifactStore,
  input: CompleteStageInput,
): CommitReport {
  const fs = internalArtifactFileSystem(store);

  const assertions: StageArtifactAssertion[] = input.artifacts.map((artifact) => ({
    relativePath: artifact.receipt.relativePath,
    assert: () => assertArtifactStillValid(fs, store, artifact),
  }));
  const artifactRelativePaths = input.artifacts.map((artifact) => artifact.receipt.relativePath);

  const payload: JsonValue = {
    runId: input.runId,
    stageId: input.stageId,
    artifacts: input.artifacts.map((artifact) => ({
      artifactId: artifact.receipt.artifactId,
      name: artifact.name,
      contentHash: artifact.receipt.contentHash,
      byteLength: artifact.receipt.byteLength,
      mediaType: artifact.mediaType,
      contentSchemaId: artifact.contentSchemaId,
      producer: artifact.producer,
      sourceLineage: [...artifact.sourceLineage],
      path: artifact.receipt.relativePath,
    })),
  };

  try {
    return commitStateChangeInternal(
      db,
      {
        runId: input.runId,
        type: "stage.completed",
        payload,
        ...(input.causationEventId !== undefined
          ? { causationEventId: input.causationEventId }
          : {}),
      },
      {
        // The row a caller of `completeStage` actually asked for — the
        // active alias, not whichever new `artifact` row happened to sort
        // first (Task 4.1's `TABLE_ORDER`/`reported[0]` fix).
        primaryTable: "stage_artifact_alias",
        artifactRelativePaths,
        assertions,
      },
    );
  } finally {
    for (const artifact of input.artifacts) {
      closeQuietly(fs, artifact.receipt.fd);
    }
  }
}
