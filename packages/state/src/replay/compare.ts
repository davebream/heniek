/**
 * The divergence report (design D11; plan Task 5.2) — the *detects* half of
 * AC3.
 *
 * **Exported API, not a test helper** (IR-5): §28.1 ships migration tooling as
 * a distribution component, and a divergence check is an operator-facing
 * recovery aid under §18.2's restart boundary. DG-7 decided exported API now,
 * **no CLI** — there is no CLI to add a subcommand to yet (Q009), and
 * speculatively shaping a command-line surface for a consumer that does not
 * exist is the over-reach X4 bans. These functions are shaped so Q009 can wrap
 * them unchanged: pure inputs, a serialisable report, no console output, no
 * `process.exit`.
 *
 * **There is no `volatileFields` exemption, and none is needed under any
 * clock** (round-1 CRIT-02). `updatedAt` is set by `applyEvent` to
 * `event.recordedAt`, and both the command path and the replay path call that
 * same pure reducer with no post-processing — so `updatedAt` is byte-identical
 * between stored and replayed state whether the injected clock advances or
 * not, because it is a pure function of the journal rather than of when
 * `commitStateChange` happened to run. It is compared like any other field.
 * **Do not add a "volatile fields" escape hatch:** it would let a genuine
 * divergence hide, and it buys nothing. The second `clock.nowIso()` in
 * `commitStateChange` feeds `CommitReport.committedAt`, which this comparison
 * never looks at.
 */

import { type SchemaFingerprint, schemaFingerprint } from "../database/fingerprint.js";
import type { StateDatabase } from "../database/open.js";
import { type JsonValue, stringifyCanonical } from "../json.js";
import type {
  ArtifactState,
  CodebaseState,
  ProjectionState,
  ProjectionTable,
  RepositoryState,
  RunState,
  StageArtifactAliasState,
  WorkspaceLeaseState,
  WorkspaceState,
} from "../projection/state.js";
import { loadStoredProjectionState, projectionDigest } from "../projection/state.js";
import { type ReplayOptions, replayJournal } from "./replay.js";

export interface Divergence {
  readonly table: ProjectionTable;
  readonly key: string;
  /** `null` when the whole row is present on one side only. */
  readonly field: string | null;
  /**
   * When `field` is `null` (finding MIN-06 — pinned so an exact-object
   * assertion has a single reading): the side the row is present on carries
   * the **entire row** as a `JsonValue` object, in the same column-name →
   * value shape the row narrowers produce; the side the row is absent from
   * carries `null`. When `field` is a string, both sides carry that one
   * field's scalar value.
   */
  readonly stored: JsonValue | null;
  readonly replayed: JsonValue | null;
}

export interface ReplayDivergenceReport {
  readonly status: "converged" | "diverged";
  readonly eventsReplayed: number;
  readonly throughSequence: number;
  /** Sorted by (table, key, field); a `null` field sorts first. */
  readonly divergences: readonly Divergence[];
  readonly projectionDigest: { readonly stored: string; readonly replayed: string };
  readonly schemaFingerprint: SchemaFingerprint;
}

/**
 * One view per table. `toJson` spells every field out rather than spreading,
 * so adding a projection column forces a visible edit here — which is the
 * standing obligation the reducer's header states: extending the vocabulary
 * without extending this comparison silently narrows the divergence checker.
 */
interface CompareView<T> {
  readonly table: ProjectionTable;
  select(state: ProjectionState): Readonly<Record<string, T>>;
  toJson(row: T): Readonly<Record<string, JsonValue>>;
}

const RUN_VIEW: CompareView<RunState> = {
  table: "run_projection",
  select: (state) => state.runs,
  toJson: (row) => ({
    runId: row.runId,
    status: row.status,
    revision: row.revision,
    lastEventSequence: row.lastEventSequence,
    workspaceId: row.workspaceId,
    codebaseId: row.codebaseId,
    updatedAt: row.updatedAt,
    instructionSnapshotSha256: row.instructionSnapshotSha256,
    instructionSnapshotJson: row.instructionSnapshotJson,
  }),
};

const CODEBASE_VIEW: CompareView<CodebaseState> = {
  table: "codebase",
  select: (state) => state.codebases,
  toJson: (row) => ({
    codebaseId: row.codebaseId,
    revision: row.revision,
    lastEventSequence: row.lastEventSequence,
    updatedAt: row.updatedAt,
    name: row.name,
    rootPath: row.rootPath,
    topologySha256: row.topologySha256,
    configurationSha256: row.configurationSha256,
    registrationJson: row.registrationJson,
    instructionSnapshotJson: row.instructionSnapshotJson,
  }),
};

const REPOSITORY_VIEW: CompareView<RepositoryState> = {
  table: "repository",
  select: (state) => state.repositories,
  toJson: (row) => ({
    repositoryId: row.repositoryId,
    codebaseId: row.codebaseId,
    revision: row.revision,
    lastEventSequence: row.lastEventSequence,
    updatedAt: row.updatedAt,
    name: row.name,
    repositoryPath: row.repositoryPath,
    gitCommonDirectory: row.gitCommonDirectory,
    remotesJson: row.remotesJson,
    defaultRemote: row.defaultRemote,
    defaultBranch: row.defaultBranch,
  }),
};

const WORKSPACE_VIEW: CompareView<WorkspaceState> = {
  table: "workspace",
  select: (state) => state.workspaces,
  toJson: (row) => ({
    workspaceId: row.workspaceId,
    codebaseId: row.codebaseId,
    repositoryId: row.repositoryId,
    lifecycleStatus: row.lifecycleStatus,
    checkoutPath: row.checkoutPath,
    configurationSha256: row.configurationSha256,
    manifestJson: row.manifestJson,
    revision: row.revision,
    lastEventSequence: row.lastEventSequence,
    updatedAt: row.updatedAt,
  }),
};

const WORKSPACE_LEASE_VIEW: CompareView<WorkspaceLeaseState> = {
  table: "workspace_lease",
  select: (state) => state.workspaceLeases,
  toJson: (row) => ({
    checkoutPath: row.checkoutPath,
    workspaceId: row.workspaceId,
    repositoryId: row.repositoryId,
    leaseId: row.leaseId,
    ownerId: row.ownerId,
    bootWitness: row.bootWitness,
    processWitnessesJson: row.processWitnessesJson,
    expectedSha: row.expectedSha,
    fencingRevision: row.fencingRevision,
    leaseState: row.leaseState,
    acquiredAt: row.acquiredAt,
    renewedAt: row.renewedAt,
    expiresAt: row.expiresAt,
    releasedAt: row.releasedAt,
    revision: row.revision,
    lastEventSequence: row.lastEventSequence,
    updatedAt: row.updatedAt,
  }),
};

const ARTIFACT_VIEW: CompareView<ArtifactState> = {
  table: "artifact",
  select: (state) => state.artifacts,
  toJson: (row) => ({
    artifactId: row.artifactId,
    runId: row.runId,
    stageId: row.stageId,
    name: row.name,
    contentHash: row.contentHash,
    byteLength: row.byteLength,
    mediaType: row.mediaType,
    contentSchemaId: row.contentSchemaId,
    producer: row.producer,
    sourceLineage: [...row.sourceLineage],
    relativePath: row.relativePath,
    createdAt: row.createdAt,
    revision: row.revision,
    lastEventSequence: row.lastEventSequence,
  }),
};

const STAGE_ARTIFACT_ALIAS_VIEW: CompareView<StageArtifactAliasState> = {
  table: "stage_artifact_alias",
  select: (state) => state.stageArtifactAliases,
  toJson: (row) => ({
    runId: row.runId,
    stageId: row.stageId,
    name: row.name,
    artifactId: row.artifactId,
    revision: row.revision,
    lastEventSequence: row.lastEventSequence,
    updatedAt: row.updatedAt,
  }),
};

function compareTable<T>(
  view: CompareView<T>,
  stored: ProjectionState,
  replayed: ProjectionState,
): readonly Divergence[] {
  const storedRows = view.select(stored);
  const replayedRows = view.select(replayed);
  const keys = new Set([...Object.keys(storedRows), ...Object.keys(replayedRows)]);
  const divergences: Divergence[] = [];

  for (const key of [...keys].sort()) {
    const storedRow = storedRows[key];
    const replayedRow = replayedRows[key];

    if (storedRow === undefined || replayedRow === undefined) {
      divergences.push({
        table: view.table,
        key,
        field: null,
        stored: storedRow === undefined ? null : view.toJson(storedRow),
        replayed: replayedRow === undefined ? null : view.toJson(replayedRow),
      });
      continue;
    }

    const storedJson = view.toJson(storedRow);
    const replayedJson = view.toJson(replayedRow);
    for (const field of Object.keys(storedJson).sort()) {
      const left = storedJson[field] ?? null;
      const right = replayedJson[field] ?? null;
      // `!==` alone is reference (in)equality — correct for every scalar
      // field every table carried before Q007, but `artifact.sourceLineage`
      // is this package's first array-valued projection field: two
      // freshly-built arrays holding identical elements are never `===`,
      // which would report a spurious divergence on every converged replay.
      // The canonical-JSON string comparison is exact for scalars too, so
      // this subsumes the old check rather than special-casing arrays.
      if (stringifyCanonical(left) !== stringifyCanonical(right)) {
        divergences.push({ table: view.table, key, field, stored: left, replayed: right });
      }
    }
  }

  return divergences;
}

/** `null` sorts before any string, so a whole-row divergence leads its key's group. */
function compareField(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  return left < right ? -1 : 1;
}

export function compareProjectionToReplay(
  db: StateDatabase,
  options?: ReplayOptions,
): ReplayDivergenceReport {
  const replay = replayJournal(db, options);
  const stored = loadStoredProjectionState(db);

  const divergences = [
    ...compareTable(ARTIFACT_VIEW, stored, replay.state),
    ...compareTable(CODEBASE_VIEW, stored, replay.state),
    ...compareTable(REPOSITORY_VIEW, stored, replay.state),
    ...compareTable(RUN_VIEW, stored, replay.state),
    ...compareTable(STAGE_ARTIFACT_ALIAS_VIEW, stored, replay.state),
    ...compareTable(WORKSPACE_VIEW, stored, replay.state),
    ...compareTable(WORKSPACE_LEASE_VIEW, stored, replay.state),
  ].sort((left, right) => {
    if (left.table !== right.table) {
      return left.table < right.table ? -1 : 1;
    }
    if (left.key !== right.key) {
      return left.key < right.key ? -1 : 1;
    }
    return compareField(left.field, right.field);
  });

  return {
    status: divergences.length === 0 ? "converged" : "diverged",
    eventsReplayed: replay.eventsReplayed,
    throughSequence: replay.throughSequence,
    divergences,
    // sha256 over the canonical JSON of each side, so a captured report is
    // byte-reproducible across runs and machines — that is what E2's
    // "deterministic replay report" means.
    projectionDigest: {
      stored: projectionDigest(stored),
      replayed: projectionDigest(replay.state),
    },
    // Attached so a report captured in evidence is self-describing about
    // which schema produced it.
    schemaFingerprint: schemaFingerprint(db),
  };
}
