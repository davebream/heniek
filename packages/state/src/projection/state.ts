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
import { type JsonValue, stringifyCanonical } from "../json.js";
import {
  type CodebaseRow,
  type RepositoryRow,
  toCodebaseRow,
  toRepositoryRow,
  toWorkspaceRow,
  type WorkspaceRow,
} from "./identity.js";
import { type RunProjectionRow, toRunProjectionRow } from "./run.js";

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

export interface ProjectionState {
  readonly runs: Readonly<Record<string, RunState>>;
  readonly codebases: Readonly<Record<string, CodebaseState>>;
  readonly repositories: Readonly<Record<string, RepositoryState>>;
  readonly workspaces: Readonly<Record<string, WorkspaceState>>;
}

export const EMPTY_PROJECTION_STATE: ProjectionState = Object.freeze({
  runs: Object.freeze({}),
  codebases: Object.freeze({}),
  repositories: Object.freeze({}),
  workspaces: Object.freeze({}),
});

export type ProjectionTable = "codebase" | "repository" | "run_projection" | "workspace";

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
 * `workspace` both carry a foreign key to `codebase`, and emitting writes in
 * this order means a parent row is always inserted before any child that
 * cites it. (The six-event vocabulary never touches two tables in one event,
 * so this ordering is currently belt-and-braces — but it is the property a
 * future multi-table event would silently need.)
 */
const TABLE_ORDER: readonly ProjectionTable[] = [
  "codebase",
  "repository",
  "run_projection",
  "workspace",
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
  };
}

function codebaseRow(state: CodebaseState): Record<string, string | number | null> {
  return {
    codebase_id: state.codebaseId,
    revision: state.revision,
    last_event_sequence: state.lastEventSequence,
    updated_at: state.updatedAt,
  };
}

function repositoryRow(state: RepositoryState): Record<string, string | number | null> {
  return {
    repository_id: state.repositoryId,
    codebase_id: state.codebaseId,
    revision: state.revision,
    last_event_sequence: state.lastEventSequence,
    updated_at: state.updatedAt,
  };
}

function workspaceRow(state: WorkspaceState): Record<string, string | number | null> {
  return {
    workspace_id: state.workspaceId,
    codebase_id: state.codebaseId,
    revision: state.revision,
    last_event_sequence: state.lastEventSequence,
    updated_at: state.updatedAt,
  };
}

/**
 * One descriptor per table so `diffProjectionState` walks all four
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
    [CODEBASE_VIEW.table, diffTable(CODEBASE_VIEW, before, after)],
    [REPOSITORY_VIEW.table, diffTable(REPOSITORY_VIEW, before, after)],
    [RUN_VIEW.table, diffTable(RUN_VIEW, before, after)],
    [WORKSPACE_VIEW.table, diffTable(WORKSPACE_VIEW, before, after)],
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
        revision: row.revision,
        lastEventSequence: row.lastEventSequence,
        updatedAt: row.updatedAt,
      };
    }
  }
  return { codebases, repositories, runs, workspaces };
}

/** sha256 over the canonical JSON — reproducible across hosts and processes. */
export function projectionDigest(state: ProjectionState): string {
  return createHash("sha256")
    .update(stringifyCanonical(projectionStateToJson(state)), "utf8")
    .digest("hex");
}

/**
 * Internal — the whole stored projection, used by the replay comparison.
 * Not barrel-exported.
 */
export function loadStoredProjectionState(db: StateDatabase): ProjectionState {
  const handle = internalHandle(db);
  const runs: Record<string, RunState> = {};
  for (const raw of handle
    .prepare(
      "SELECT run_id, status, revision, last_event_sequence, workspace_id, codebase_id, updated_at" +
        " FROM run_projection ORDER BY run_id",
    )
    .all()) {
    const row = toRunProjectionRow(raw);
    runs[row.runId] = row;
  }
  const codebases: Record<string, CodebaseState> = {};
  for (const raw of handle
    .prepare(
      "SELECT codebase_id, revision, last_event_sequence, updated_at FROM codebase ORDER BY codebase_id",
    )
    .all()) {
    const row = toCodebaseRow(raw);
    codebases[row.codebaseId] = row;
  }
  const repositories: Record<string, RepositoryState> = {};
  for (const raw of handle
    .prepare(
      "SELECT repository_id, codebase_id, revision, last_event_sequence, updated_at" +
        " FROM repository ORDER BY repository_id",
    )
    .all()) {
    const row = toRepositoryRow(raw);
    repositories[row.repositoryId] = row;
  }
  const workspaces: Record<string, WorkspaceState> = {};
  for (const raw of handle
    .prepare(
      "SELECT workspace_id, codebase_id, revision, last_event_sequence, updated_at" +
        " FROM workspace ORDER BY workspace_id",
    )
    .all()) {
    const row = toWorkspaceRow(raw);
    workspaces[row.workspaceId] = row;
  }
  return { codebases, repositories, runs, workspaces };
}

export interface ProjectionScope {
  readonly runs: readonly string[];
  readonly codebases: readonly string[];
  readonly repositories: readonly string[];
  readonly workspaces: readonly string[];
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
  const runStatement = handle.prepare(
    "SELECT run_id, status, revision, last_event_sequence, workspace_id, codebase_id, updated_at" +
      " FROM run_projection WHERE run_id = ?",
  );
  for (const key of scope.runs) {
    const raw = runStatement.get(key);
    if (raw !== undefined) {
      runs[key] = toRunProjectionRow(raw);
    }
  }
  const codebases: Record<string, CodebaseState> = {};
  const codebaseStatement = handle.prepare(
    "SELECT codebase_id, revision, last_event_sequence, updated_at FROM codebase WHERE codebase_id = ?",
  );
  for (const key of scope.codebases) {
    const raw = codebaseStatement.get(key);
    if (raw !== undefined) {
      codebases[key] = toCodebaseRow(raw);
    }
  }
  const repositories: Record<string, RepositoryState> = {};
  const repositoryStatement = handle.prepare(
    "SELECT repository_id, codebase_id, revision, last_event_sequence, updated_at" +
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
    "SELECT workspace_id, codebase_id, revision, last_event_sequence, updated_at" +
      " FROM workspace WHERE workspace_id = ?",
  );
  for (const key of scope.workspaces) {
    const raw = workspaceStatement.get(key);
    if (raw !== undefined) {
      workspaces[key] = toWorkspaceRow(raw);
    }
  }
  return { codebases, repositories, runs, workspaces };
}
