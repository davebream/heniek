/**
 * The in-memory projection value the reducer folds, the diff that turns two
 * of them into explicit writes, and the canonical JSON/digest views the
 * replay comparison consumes (design D8, D11; plan Task 4.1).
 *
 * Plain frozen records rather than `Map`s: `canonicalize` sorts object keys
 * directly, spreads keep the reducer obviously pure, and the volumes here are
 * small. `noUncheckedIndexedAccess` makes every lookup `T | undefined`, which
 * is exactly the narrowing the reducer needs anyway.
 */

import { createHash } from "node:crypto";
import { internalHandle, type StateDatabase } from "../database/open.js";
import { readUserVersion, toSafeInteger, toText } from "../database/pragma.js";
import { StateDatabaseCorruptionError } from "../errors.js";
import { type JsonValue, parseJsonValue, stringifyCanonical } from "../json.js";
import {
  type CodebaseRow,
  type RepositoryRow,
  toCodebaseRow,
  toRepositoryRow,
  toWorkspaceRow,
  type WorkspaceRow,
} from "./identity.js";
import { type RunProjectionRow, runProjectionSelectColumns, toRunProjectionRow } from "./run.js";
import {
  toWorkspaceLeaseRow,
  WORKSPACE_LEASE_COLUMNS,
  type WorkspaceLeaseRow,
} from "./workspace-lease.js";

/**
 * Aliased, not re-declared (finding MIN-11): the reads in Task 3.4 produce a
 * `RunProjectionRow`/`CodebaseRow`/`RepositoryRow`/`WorkspaceRow`, while the
 * divergence walk consumes a `RunState`/`CodebaseState`/… . The two families
 * were structurally identical field-for-field, and keeping them as separately
 * declared interfaces would let a future migration extend one and not the
 * other — silently narrowing AC3's "detects divergence" claim without ever
 * producing a compile error. `RunState.status` is therefore
 * `@heniek/contracts`' `RunStatus` by inheritance, with no second declaration
 * of the vocabulary here.
 */
export type RunState = RunProjectionRow;
export type CodebaseState = CodebaseRow;
export type RepositoryState = RepositoryRow;
export type WorkspaceState = WorkspaceRow;
export type WorkspaceLeaseState = WorkspaceLeaseRow;

/**
 * The `artifact` row (design D11, D11a; plan Task 2.2). Immutable once
 * written — `revision` is always `1`, and the table carries no
 * `*_causal_update` trigger to guard a second revision, because there is
 * never a second one. Keyed by `artifactId`.
 */
export interface ArtifactState {
  readonly artifactId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly name: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly contentSchemaId: string;
  readonly producer: string;
  readonly sourceLineage: readonly string[];
  readonly relativePath: string;
  readonly createdAt: string;
  readonly revision: number;
  readonly lastEventSequence: number;
}

/**
 * The `stage_artifact_alias` row — the §16.2 "active artifact alias". The
 * one deliberately mutable row in the design: a retry re-points `artifactId`
 * to a new, still-immutable artifact rather than mutating it. Keyed by
 * `stageArtifactAliasKey(runId, stageId, name)`, since the table's primary
 * key is the composite `(run_id, stage_id, name)`.
 */
export interface StageArtifactAliasState {
  readonly runId: string;
  readonly stageId: string;
  readonly name: string;
  readonly artifactId: string;
  readonly revision: number;
  readonly lastEventSequence: number;
  readonly updatedAt: string;
}

/**
 * `stage_artifact_alias`'s primary key is the composite `(run_id, stage_id,
 * name)`, but `ProjectionState`'s per-table maps are all `Record<string, …>`
 * (design precedent: every other table has a single-column key). U+0000
 * never appears in any of the three constituent ids (they are caller-chosen
 * identifiers, never raw artifact bytes), so joining on it cannot collide
 * two distinct triples onto the same string the way a printable delimiter
 * like `:` could if an id ever contained one.
 */
export function stageArtifactAliasKey(runId: string, stageId: string, name: string): string {
  return `${runId}\u0000${stageId}\u0000${name}`;
}

export interface ProjectionState {
  readonly runs: Readonly<Record<string, RunState>>;
  readonly codebases: Readonly<Record<string, CodebaseState>>;
  readonly repositories: Readonly<Record<string, RepositoryState>>;
  readonly workspaces: Readonly<Record<string, WorkspaceState>>;
  /** Keyed by canonical checkout path. */
  readonly workspaceLeases: Readonly<Record<string, WorkspaceLeaseState>>;
  readonly artifacts: Readonly<Record<string, ArtifactState>>;
  /** Keyed by `stageArtifactAliasKey`. */
  readonly stageArtifactAliases: Readonly<Record<string, StageArtifactAliasState>>;
}

export const EMPTY_PROJECTION_STATE: ProjectionState = Object.freeze({
  runs: Object.freeze({}),
  codebases: Object.freeze({}),
  repositories: Object.freeze({}),
  workspaces: Object.freeze({}),
  workspaceLeases: Object.freeze({}),
  artifacts: Object.freeze({}),
  stageArtifactAliases: Object.freeze({}),
});

export type ProjectionTable =
  | "artifact"
  | "codebase"
  | "repository"
  | "run_projection"
  | "stage_artifact_alias"
  | "workspace"
  | "workspace_lease";

export interface ProjectionWrite {
  readonly table: ProjectionTable;
  readonly key: string;
  /** `null` ⇒ INSERT (revision must be 1); otherwise UPDATE … WHERE key = ? AND revision = ?. */
  readonly previousRevision: number | null;
  /** Column name → bound value. */
  readonly row: Readonly<Record<string, string | number | null>>;
}

/**
 * Alphabetical, and load-bearing rather than incidental: `repository` and
 * `workspace` both carry a foreign key to `codebase`, `stage_artifact_alias`
 * carries one to `artifact`, and emitting writes in this order means a
 * parent row is always inserted before any child that cites it.
 * `stage.completed` (design D4) is the first event to touch two tables in
 * one commit — `artifact` sorts before `stage_artifact_alias`, which is
 * exactly the ordering Phase 4's `primaryTable` fix (Task 4.1) exists to
 * override for `CommitReport.revision`.
 */
const TABLE_ORDER: readonly ProjectionTable[] = [
  "artifact",
  "codebase",
  "repository",
  "run_projection",
  "stage_artifact_alias",
  "workspace",
  "workspace_lease",
];

function runRow(state: RunState): Record<string, string | number | null> {
  return {
    run_id: state.runId,
    status: state.status,
    revision: state.revision,
    last_event_sequence: state.lastEventSequence,
    codebase_id: state.codebaseId,
    updated_at: state.updatedAt,
    workspace_id: state.workspaceId,
    instruction_snapshot_sha256: state.instructionSnapshotSha256,
    instruction_snapshot_json: state.instructionSnapshotJson,
    capability_landing_json: state.capabilityLandingJson,
  };
}

function codebaseRow(state: CodebaseState): Record<string, string | number | null> {
  return {
    codebase_id: state.codebaseId,
    revision: state.revision,
    last_event_sequence: state.lastEventSequence,
    updated_at: state.updatedAt,
    name: state.name,
    root_path: state.rootPath,
    topology_sha256: state.topologySha256,
    configuration_sha256: state.configurationSha256,
    registration_json: state.registrationJson,
    instruction_snapshot_json: state.instructionSnapshotJson,
  };
}

function repositoryRow(state: RepositoryState): Record<string, string | number | null> {
  return {
    repository_id: state.repositoryId,
    codebase_id: state.codebaseId,
    revision: state.revision,
    last_event_sequence: state.lastEventSequence,
    updated_at: state.updatedAt,
    name: state.name,
    repository_path: state.repositoryPath,
    git_common_directory: state.gitCommonDirectory,
    remotes_json: state.remotesJson,
    default_remote: state.defaultRemote,
    default_branch: state.defaultBranch,
  };
}

function workspaceRow(state: WorkspaceState): Record<string, string | number | null> {
  return {
    workspace_id: state.workspaceId,
    codebase_id: state.codebaseId,
    repository_id: state.repositoryId,
    lifecycle_status: state.lifecycleStatus,
    checkout_path: state.checkoutPath,
    configuration_sha256: state.configurationSha256,
    manifest_json: state.manifestJson,
    revision: state.revision,
    last_event_sequence: state.lastEventSequence,
    updated_at: state.updatedAt,
  };
}

function workspaceLeaseRow(state: WorkspaceLeaseState): Record<string, string | number | null> {
  return {
    checkout_path: state.checkoutPath,
    workspace_id: state.workspaceId,
    repository_id: state.repositoryId,
    lease_id: state.leaseId,
    owner_id: state.ownerId,
    boot_witness: state.bootWitness,
    process_witnesses_json: state.processWitnessesJson,
    expected_sha: state.expectedSha,
    fencing_revision: state.fencingRevision,
    lease_state: state.leaseState,
    acquired_at: state.acquiredAt,
    renewed_at: state.renewedAt,
    expires_at: state.expiresAt,
    released_at: state.releasedAt,
    revision: state.revision,
    last_event_sequence: state.lastEventSequence,
    updated_at: state.updatedAt,
  };
}

function artifactRow(state: ArtifactState): Record<string, string | number | null> {
  return {
    artifact_id: state.artifactId,
    run_id: state.runId,
    stage_id: state.stageId,
    name: state.name,
    content_hash: state.contentHash,
    byte_length: state.byteLength,
    media_type: state.mediaType,
    content_schema_id: state.contentSchemaId,
    producer: state.producer,
    source_lineage: stringifyCanonical(state.sourceLineage),
    relative_path: state.relativePath,
    created_at: state.createdAt,
    revision: state.revision,
    last_event_sequence: state.lastEventSequence,
  };
}

function stageArtifactAliasRow(
  state: StageArtifactAliasState,
): Record<string, string | number | null> {
  return {
    run_id: state.runId,
    stage_id: state.stageId,
    name: state.name,
    artifact_id: state.artifactId,
    revision: state.revision,
    last_event_sequence: state.lastEventSequence,
    updated_at: state.updatedAt,
  };
}

/**
 * One descriptor per table so `diffProjectionState` walks all six
 * identically instead of repeating the same before/after comparison with
 * different field names — a shape that has historically drifted (one table
 * gaining a check the others lack) exactly the way MIN-11 warns about.
 */
interface TableView<T> {
  readonly table: ProjectionTable;
  select(state: ProjectionState): Readonly<Record<string, T>>;
  revisionOf(row: T): number;
  toRow(row: T): Record<string, string | number | null>;
}

const RUN_VIEW: TableView<RunState> = {
  table: "run_projection",
  select: (state) => state.runs,
  revisionOf: (row) => row.revision,
  toRow: runRow,
};
const CODEBASE_VIEW: TableView<CodebaseState> = {
  table: "codebase",
  select: (state) => state.codebases,
  revisionOf: (row) => row.revision,
  toRow: codebaseRow,
};
const REPOSITORY_VIEW: TableView<RepositoryState> = {
  table: "repository",
  select: (state) => state.repositories,
  revisionOf: (row) => row.revision,
  toRow: repositoryRow,
};
const WORKSPACE_VIEW: TableView<WorkspaceState> = {
  table: "workspace",
  select: (state) => state.workspaces,
  revisionOf: (row) => row.revision,
  toRow: workspaceRow,
};

const WORKSPACE_LEASE_VIEW: TableView<WorkspaceLeaseState> = {
  table: "workspace_lease",
  select: (state) => state.workspaceLeases,
  revisionOf: (row) => row.revision,
  toRow: workspaceLeaseRow,
};
/**
 * `revisionOf` always returns the row's own `revision`, which is always `1`
 * (an artifact row is written once and never diffed against an earlier
 * revision of itself — `diffTable` only ever takes this view's INSERT
 * branch). Not special-cased away: keeping the same `TableView<T>` shape
 * every other table uses is what lets `diffProjectionState` walk all six
 * tables identically.
 */
const ARTIFACT_VIEW: TableView<ArtifactState> = {
  table: "artifact",
  select: (state) => state.artifacts,
  revisionOf: (row) => row.revision,
  toRow: artifactRow,
};
const STAGE_ARTIFACT_ALIAS_VIEW: TableView<StageArtifactAliasState> = {
  table: "stage_artifact_alias",
  select: (state) => state.stageArtifactAliases,
  revisionOf: (row) => row.revision,
  toRow: stageArtifactAliasRow,
};

function diffTable<T>(
  view: TableView<T>,
  before: ProjectionState,
  after: ProjectionState,
): readonly ProjectionWrite[] {
  const beforeRows = view.select(before);
  const afterRows = view.select(after);
  const writes: ProjectionWrite[] = [];
  for (const key of Object.keys(afterRows).sort()) {
    const next = afterRows[key];
    if (next === undefined) {
      continue;
    }
    const previous = beforeRows[key];
    if (previous === undefined) {
      writes.push({
        table: view.table,
        key,
        previousRevision: null,
        row: view.toRow(next),
      });
      continue;
    }
    if (view.revisionOf(previous) === view.revisionOf(next)) {
      // Same revision means the reducer did not touch this row. Emitting an
      // UPDATE anyway would trip the causal-guard trigger (which demands
      // `revision = OLD.revision + 1`) for a row nothing actually changed.
      continue;
    }
    writes.push({
      table: view.table,
      key,
      previousRevision: view.revisionOf(previous),
      row: view.toRow(next),
    });
  }
  return writes;
}

/**
 * Pure. Produces the explicit INSERT/UPDATE list, in table-then-key order.
 * **Never an upsert** (D8/V9) — the caller emits one or the other based on
 * `previousRevision`, because SQLite evaluates `BEFORE INSERT` triggers ahead
 * of conflict resolution and an upsert is refused by the first-revision guard
 * even on its UPDATE branch.
 *
 * Row *removals* produce no write: nothing in the six-event vocabulary
 * deletes a projection row, and silently emitting a DELETE for one would be
 * inventing a capability the schema's append-only posture deliberately lacks.
 */
export function diffProjectionState(
  before: ProjectionState,
  after: ProjectionState,
): readonly ProjectionWrite[] {
  const byTable = new Map<ProjectionTable, readonly ProjectionWrite[]>([
    [ARTIFACT_VIEW.table, diffTable(ARTIFACT_VIEW, before, after)],
    [CODEBASE_VIEW.table, diffTable(CODEBASE_VIEW, before, after)],
    [REPOSITORY_VIEW.table, diffTable(REPOSITORY_VIEW, before, after)],
    [RUN_VIEW.table, diffTable(RUN_VIEW, before, after)],
    [STAGE_ARTIFACT_ALIAS_VIEW.table, diffTable(STAGE_ARTIFACT_ALIAS_VIEW, before, after)],
    [WORKSPACE_VIEW.table, diffTable(WORKSPACE_VIEW, before, after)],
    [WORKSPACE_LEASE_VIEW.table, diffTable(WORKSPACE_LEASE_VIEW, before, after)],
  ]);
  return TABLE_ORDER.flatMap((table) => byTable.get(table) ?? []);
}

/**
 * Canonical JSON view — the digest input and the divergence comparison input.
 * Every row is spelled out field by field rather than spread, so adding a
 * column to a projection table forces a visible edit here instead of silently
 * widening (or, worse, silently *not* widening) what the digest covers.
 */
export function projectionStateToJson(state: ProjectionState): JsonValue {
  const runs: Record<string, JsonValue> = {};
  for (const key of Object.keys(state.runs).sort()) {
    const row = state.runs[key];
    if (row !== undefined) {
      runs[key] = {
        runId: row.runId,
        status: row.status,
        revision: row.revision,
        lastEventSequence: row.lastEventSequence,
        workspaceId: row.workspaceId,
        codebaseId: row.codebaseId,
        updatedAt: row.updatedAt,
        instructionSnapshotSha256: row.instructionSnapshotSha256,
        instructionSnapshotJson: row.instructionSnapshotJson,
        capabilityLandingJson: row.capabilityLandingJson,
      };
    }
  }
  const codebases: Record<string, JsonValue> = {};
  for (const key of Object.keys(state.codebases).sort()) {
    const row = state.codebases[key];
    if (row !== undefined) {
      codebases[key] = {
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
      };
    }
  }
  const repositories: Record<string, JsonValue> = {};
  for (const key of Object.keys(state.repositories).sort()) {
    const row = state.repositories[key];
    if (row !== undefined) {
      repositories[key] = {
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
      };
    }
  }
  const workspaces: Record<string, JsonValue> = {};
  for (const key of Object.keys(state.workspaces).sort()) {
    const row = state.workspaces[key];
    if (row !== undefined) {
      workspaces[key] = {
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
      };
    }
  }
  const workspaceLeases: Record<string, JsonValue> = {};
  for (const key of Object.keys(state.workspaceLeases).sort()) {
    const row = state.workspaceLeases[key];
    if (row !== undefined) {
      workspaceLeases[key] = {
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
      };
    }
  }
  const artifacts: Record<string, JsonValue> = {};
  for (const key of Object.keys(state.artifacts).sort()) {
    const row = state.artifacts[key];
    if (row !== undefined) {
      artifacts[key] = {
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
      };
    }
  }
  const stageArtifactAliases: Record<string, JsonValue> = {};
  for (const key of Object.keys(state.stageArtifactAliases).sort()) {
    const row = state.stageArtifactAliases[key];
    if (row !== undefined) {
      stageArtifactAliases[key] = {
        runId: row.runId,
        stageId: row.stageId,
        name: row.name,
        artifactId: row.artifactId,
        revision: row.revision,
        lastEventSequence: row.lastEventSequence,
        updatedAt: row.updatedAt,
      };
    }
  }
  return {
    artifacts,
    codebases,
    repositories,
    runs,
    stageArtifactAliases,
    workspaces,
    workspaceLeases,
  };
}

/** sha256 over the canonical JSON — reproducible across hosts and processes. */
export function projectionDigest(state: ProjectionState): string {
  return createHash("sha256")
    .update(stringifyCanonical(projectionStateToJson(state)), "utf8")
    .digest("hex");
}

const ARTIFACT_COLUMNS =
  "artifact_id, run_id, stage_id, name, content_hash, byte_length, media_type," +
  " content_schema_id, producer, source_lineage, relative_path, created_at, revision," +
  " last_event_sequence";

const STAGE_ARTIFACT_ALIAS_COLUMNS =
  "run_id, stage_id, name, artifact_id, revision, last_event_sequence, updated_at";

/**
 * `source_lineage` narrows via `parseJsonValue` (the one JSON-parsing entry
 * point every raw payload/column goes through in this package) and then a
 * shallow element check — the migration's `CHECK (json_valid(source_lineage))`
 * only proves the column is *some* JSON value, not that every element is a
 * string.
 */
function toArtifactIdArray(raw: unknown, what: string): readonly string[] {
  const text = toText(raw, what);
  const parsed = parseJsonValue(text, what);
  if (!Array.isArray(parsed)) {
    throw new StateDatabaseCorruptionError(`${what} is not a JSON array`);
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new StateDatabaseCorruptionError(`${what}[${index}] is not a string`);
    }
    return entry;
  });
}

function toArtifactRow(raw: Record<string, unknown>): ArtifactState {
  return {
    artifactId: toText(raw.artifact_id, "artifact.artifact_id"),
    runId: toText(raw.run_id, "artifact.run_id"),
    stageId: toText(raw.stage_id, "artifact.stage_id"),
    name: toText(raw.name, "artifact.name"),
    contentHash: toText(raw.content_hash, "artifact.content_hash"),
    byteLength: toSafeInteger(raw.byte_length, "artifact.byte_length"),
    mediaType: toText(raw.media_type, "artifact.media_type"),
    contentSchemaId: toText(raw.content_schema_id, "artifact.content_schema_id"),
    producer: toText(raw.producer, "artifact.producer"),
    sourceLineage: toArtifactIdArray(raw.source_lineage, "artifact.source_lineage"),
    relativePath: toText(raw.relative_path, "artifact.relative_path"),
    createdAt: toText(raw.created_at, "artifact.created_at"),
    revision: toSafeInteger(raw.revision, "artifact.revision"),
    lastEventSequence: toSafeInteger(raw.last_event_sequence, "artifact.last_event_sequence"),
  };
}

function toStageArtifactAliasRow(raw: Record<string, unknown>): StageArtifactAliasState {
  return {
    runId: toText(raw.run_id, "stage_artifact_alias.run_id"),
    stageId: toText(raw.stage_id, "stage_artifact_alias.stage_id"),
    name: toText(raw.name, "stage_artifact_alias.name"),
    artifactId: toText(raw.artifact_id, "stage_artifact_alias.artifact_id"),
    revision: toSafeInteger(raw.revision, "stage_artifact_alias.revision"),
    lastEventSequence: toSafeInteger(
      raw.last_event_sequence,
      "stage_artifact_alias.last_event_sequence",
    ),
    updatedAt: toText(raw.updated_at, "stage_artifact_alias.updated_at"),
  };
}

/**
 * Internal — the whole stored projection, used by the replay comparison.
 * Not barrel-exported.
 */
export function loadStoredProjectionState(db: StateDatabase): ProjectionState {
  const handle = internalHandle(db);
  const runs: Record<string, RunState> = {};
  const runColumns = runProjectionSelectColumns(readUserVersion(handle));
  for (const raw of handle
    .prepare(`SELECT ${runColumns} FROM run_projection ORDER BY run_id`)
    .all()) {
    const row = toRunProjectionRow(raw);
    runs[row.runId] = row;
  }
  const codebases: Record<string, CodebaseState> = {};
  for (const raw of handle
    .prepare(
      "SELECT codebase_id, revision, last_event_sequence, updated_at, name, root_path," +
        " topology_sha256, configuration_sha256, registration_json, instruction_snapshot_json" +
        " FROM codebase ORDER BY codebase_id",
    )
    .all()) {
    const row = toCodebaseRow(raw);
    codebases[row.codebaseId] = row;
  }
  const repositories: Record<string, RepositoryState> = {};
  for (const raw of handle
    .prepare(
      "SELECT repository_id, codebase_id, revision, last_event_sequence, updated_at, name," +
        " repository_path, git_common_directory, remotes_json, default_remote, default_branch" +
        " FROM repository ORDER BY repository_id",
    )
    .all()) {
    const row = toRepositoryRow(raw);
    repositories[row.repositoryId] = row;
  }
  const workspaces: Record<string, WorkspaceState> = {};
  for (const raw of handle
    .prepare(
      "SELECT workspace_id, codebase_id, repository_id, lifecycle_status, checkout_path," +
        " configuration_sha256, manifest_json, revision, last_event_sequence, updated_at" +
        " FROM workspace ORDER BY workspace_id",
    )
    .all()) {
    const row = toWorkspaceRow(raw);
    workspaces[row.workspaceId] = row;
  }
  const workspaceLeases: Record<string, WorkspaceLeaseState> = {};
  for (const raw of handle
    .prepare(`SELECT ${WORKSPACE_LEASE_COLUMNS} FROM workspace_lease ORDER BY checkout_path`)
    .all()) {
    const row = toWorkspaceLeaseRow(raw);
    workspaceLeases[row.checkoutPath] = row;
  }
  const artifacts: Record<string, ArtifactState> = {};
  for (const raw of handle
    .prepare(`SELECT ${ARTIFACT_COLUMNS} FROM artifact ORDER BY artifact_id`)
    .all()) {
    const row = toArtifactRow(raw);
    artifacts[row.artifactId] = row;
  }
  const stageArtifactAliases: Record<string, StageArtifactAliasState> = {};
  for (const raw of handle
    .prepare(
      `SELECT ${STAGE_ARTIFACT_ALIAS_COLUMNS} FROM stage_artifact_alias` +
        " ORDER BY run_id, stage_id, name",
    )
    .all()) {
    const row = toStageArtifactAliasRow(raw);
    stageArtifactAliases[stageArtifactAliasKey(row.runId, row.stageId, row.name)] = row;
  }
  return {
    artifacts,
    codebases,
    repositories,
    runs,
    stageArtifactAliases,
    workspaces,
    workspaceLeases,
  };
}

/** One `(runId, stageId, name)` triple — `stage_artifact_alias`'s composite primary key. */
export interface StageArtifactAliasScopeKey {
  readonly runId: string;
  readonly stageId: string;
  readonly name: string;
}

export interface ProjectionScope {
  readonly runs: readonly string[];
  readonly codebases: readonly string[];
  readonly repositories: readonly string[];
  readonly workspaces: readonly string[];
  readonly workspaceLeases?: readonly string[];
  /** `artifactId`s. */
  readonly artifacts: readonly string[];
  readonly stageArtifactAliases: readonly StageArtifactAliasScopeKey[];
}

/**
 * Internal — loads exactly the rows an event can read or write, so
 * `commitStateChange` does not pull the whole projection into memory on every
 * command. Not barrel-exported.
 *
 * A key that is not present in storage is simply absent from the result;
 * that absence is meaningful to the reducer (it is how "this run does not
 * exist yet" is expressed), so it must not be filled in with a placeholder.
 */
export function loadScopedProjectionState(
  db: StateDatabase,
  scope: ProjectionScope,
): ProjectionState {
  const handle = internalHandle(db);
  const runs: Record<string, RunState> = {};
  const runColumns = runProjectionSelectColumns(readUserVersion(handle));
  const runStatement = handle.prepare(`SELECT ${runColumns} FROM run_projection WHERE run_id = ?`);
  for (const key of scope.runs) {
    const raw = runStatement.get(key);
    if (raw !== undefined) {
      runs[key] = toRunProjectionRow(raw);
    }
  }
  const codebases: Record<string, CodebaseState> = {};
  const codebaseStatement = handle.prepare(
    "SELECT codebase_id, revision, last_event_sequence, updated_at, name, root_path," +
      " topology_sha256, configuration_sha256, registration_json, instruction_snapshot_json" +
      " FROM codebase WHERE codebase_id = ?",
  );
  for (const key of scope.codebases) {
    const raw = codebaseStatement.get(key);
    if (raw !== undefined) {
      codebases[key] = toCodebaseRow(raw);
    }
  }
  const repositories: Record<string, RepositoryState> = {};
  const repositoryStatement = handle.prepare(
    "SELECT repository_id, codebase_id, revision, last_event_sequence, updated_at, name," +
      " repository_path, git_common_directory, remotes_json, default_remote, default_branch" +
      " FROM repository WHERE repository_id = ?",
  );
  for (const key of scope.repositories) {
    const raw = repositoryStatement.get(key);
    if (raw !== undefined) {
      repositories[key] = toRepositoryRow(raw);
    }
  }
  const workspaces: Record<string, WorkspaceState> = {};
  const workspaceStatement = handle.prepare(
    "SELECT workspace_id, codebase_id, repository_id, lifecycle_status, checkout_path," +
      " configuration_sha256, manifest_json, revision, last_event_sequence, updated_at" +
      " FROM workspace WHERE workspace_id = ?",
  );
  for (const key of scope.workspaces) {
    const raw = workspaceStatement.get(key);
    if (raw !== undefined) {
      workspaces[key] = toWorkspaceRow(raw);
    }
  }
  const workspaceLeases: Record<string, WorkspaceLeaseState> = {};
  const workspaceLeaseStatement = handle.prepare(
    `SELECT ${WORKSPACE_LEASE_COLUMNS} FROM workspace_lease WHERE checkout_path = ?`,
  );
  for (const key of scope.workspaceLeases ?? []) {
    const raw = workspaceLeaseStatement.get(key);
    if (raw !== undefined) {
      workspaceLeases[key] = toWorkspaceLeaseRow(raw);
    }
  }
  const artifacts: Record<string, ArtifactState> = {};
  const artifactStatement = handle.prepare(
    `SELECT ${ARTIFACT_COLUMNS} FROM artifact WHERE artifact_id = ?`,
  );
  for (const key of scope.artifacts) {
    const raw = artifactStatement.get(key);
    if (raw !== undefined) {
      artifacts[key] = toArtifactRow(raw);
    }
  }
  const stageArtifactAliases: Record<string, StageArtifactAliasState> = {};
  const stageArtifactAliasStatement = handle.prepare(
    `SELECT ${STAGE_ARTIFACT_ALIAS_COLUMNS} FROM stage_artifact_alias` +
      " WHERE run_id = ? AND stage_id = ? AND name = ?",
  );
  for (const scopeKey of scope.stageArtifactAliases) {
    const raw = stageArtifactAliasStatement.get(scopeKey.runId, scopeKey.stageId, scopeKey.name);
    if (raw !== undefined) {
      const key = stageArtifactAliasKey(scopeKey.runId, scopeKey.stageId, scopeKey.name);
      stageArtifactAliases[key] = toStageArtifactAliasRow(raw);
    }
  }
  return {
    artifacts,
    codebases,
    repositories,
    runs,
    stageArtifactAliases,
    workspaces,
    workspaceLeases,
  };
}
