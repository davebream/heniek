/**
 * Identity projection rows and their named reads (design D8, D9; plan Task
 * 3.4 and P2).
 *
 * These tables carry identities **and relationships** and nothing else — no
 * name, status, URL or branch columns, which belong to Q010/Q011/Q034. The
 * relationship columns (`repository.codebase_id`, `workspace.codebase_id`)
 * *are* present, FK-enforced against `codebase`.
 *
 * `readIdentity` is written as three overload signatures rather than one
 * union-returning function so a caller gets an exact row type without having
 * to narrow the result themselves.
 */

import { internalHandle, type StateDatabase } from "../database/open.js";
import { toNullableText, toSafeInteger, toText } from "../database/pragma.js";

export interface CodebaseRow {
  readonly codebaseId: string;
  readonly revision: number;
  readonly lastEventSequence: number;
  readonly updatedAt: string;
  readonly name: string | null;
  readonly rootPath: string | null;
  readonly topologySha256: string | null;
  readonly configurationSha256: string | null;
  readonly registrationJson: string | null;
  readonly instructionSnapshotJson: string | null;
}

export interface RepositoryRow {
  readonly repositoryId: string;
  readonly codebaseId: string;
  readonly revision: number;
  readonly lastEventSequence: number;
  readonly updatedAt: string;
  readonly name: string | null;
  readonly repositoryPath: string | null;
  readonly gitCommonDirectory: string | null;
  readonly remotesJson: string | null;
  readonly defaultRemote: string | null;
  readonly defaultBranch: string | null;
}

export interface WorkspaceRow {
  readonly workspaceId: string;
  readonly codebaseId: string;
  readonly revision: number;
  readonly lastEventSequence: number;
  readonly updatedAt: string;
}

const CODEBASE_COLUMNS =
  "codebase_id, revision, last_event_sequence, updated_at, name, root_path, topology_sha256," +
  " configuration_sha256, registration_json, instruction_snapshot_json";
const REPOSITORY_COLUMNS =
  "repository_id, codebase_id, revision, last_event_sequence, updated_at, name, repository_path," +
  " git_common_directory, remotes_json, default_remote, default_branch";
const WORKSPACE_COLUMNS = "workspace_id, codebase_id, revision, last_event_sequence, updated_at";

/**
 * Explicit per-table narrowing functions, one per row shape — deliberately
 * not one generic helper parameterised by column name. A generic version
 * would have to index the raw row dynamically, which `noUncheckedIndexedAccess`
 * makes awkward and which loses the per-column `what` string that makes a
 * narrowing failure name the exact column that was wrong.
 */
export function toCodebaseRow(raw: Record<string, unknown>): CodebaseRow {
  return {
    codebaseId: toText(raw.codebase_id, "codebase.codebase_id"),
    revision: toSafeInteger(raw.revision, "codebase.revision"),
    lastEventSequence: toSafeInteger(raw.last_event_sequence, "codebase.last_event_sequence"),
    updatedAt: toText(raw.updated_at, "codebase.updated_at"),
    name: toNullableText(raw.name, "codebase.name"),
    rootPath: toNullableText(raw.root_path, "codebase.root_path"),
    topologySha256: toNullableText(raw.topology_sha256, "codebase.topology_sha256"),
    configurationSha256: toNullableText(raw.configuration_sha256, "codebase.configuration_sha256"),
    registrationJson: toNullableText(raw.registration_json, "codebase.registration_json"),
    instructionSnapshotJson: toNullableText(
      raw.instruction_snapshot_json,
      "codebase.instruction_snapshot_json",
    ),
  };
}

export function toRepositoryRow(raw: Record<string, unknown>): RepositoryRow {
  return {
    repositoryId: toText(raw.repository_id, "repository.repository_id"),
    codebaseId: toText(raw.codebase_id, "repository.codebase_id"),
    revision: toSafeInteger(raw.revision, "repository.revision"),
    lastEventSequence: toSafeInteger(raw.last_event_sequence, "repository.last_event_sequence"),
    updatedAt: toText(raw.updated_at, "repository.updated_at"),
    name: toNullableText(raw.name, "repository.name"),
    repositoryPath: toNullableText(raw.repository_path, "repository.repository_path"),
    gitCommonDirectory: toNullableText(raw.git_common_directory, "repository.git_common_directory"),
    remotesJson: toNullableText(raw.remotes_json, "repository.remotes_json"),
    defaultRemote: toNullableText(raw.default_remote, "repository.default_remote"),
    defaultBranch: toNullableText(raw.default_branch, "repository.default_branch"),
  };
}

export function toWorkspaceRow(raw: Record<string, unknown>): WorkspaceRow {
  return {
    workspaceId: toText(raw.workspace_id, "workspace.workspace_id"),
    codebaseId: toText(raw.codebase_id, "workspace.codebase_id"),
    revision: toSafeInteger(raw.revision, "workspace.revision"),
    lastEventSequence: toSafeInteger(raw.last_event_sequence, "workspace.last_event_sequence"),
    updatedAt: toText(raw.updated_at, "workspace.updated_at"),
  };
}

export function readIdentity(
  db: StateDatabase,
  kind: "codebase",
  id: string,
): CodebaseRow | undefined;
export function readIdentity(
  db: StateDatabase,
  kind: "repository",
  id: string,
): RepositoryRow | undefined;
export function readIdentity(
  db: StateDatabase,
  kind: "workspace",
  id: string,
): WorkspaceRow | undefined;
export function readIdentity(
  db: StateDatabase,
  kind: "codebase" | "repository" | "workspace",
  id: string,
): CodebaseRow | RepositoryRow | WorkspaceRow | undefined {
  const handle = internalHandle(db);
  // Each branch names its own table, columns and key literally. The table
  // name is never interpolated from `kind` — `kind` is a closed union here,
  // but building SQL identifiers by concatenation is the habit V15 bans, and
  // a `switch` costs nothing to keep it out of the package entirely.
  switch (kind) {
    case "codebase": {
      const row = handle
        .prepare(`SELECT ${CODEBASE_COLUMNS} FROM codebase WHERE codebase_id = ?`)
        .get(id);
      return row === undefined ? undefined : toCodebaseRow(row);
    }
    case "repository": {
      const row = handle
        .prepare(`SELECT ${REPOSITORY_COLUMNS} FROM repository WHERE repository_id = ?`)
        .get(id);
      return row === undefined ? undefined : toRepositoryRow(row);
    }
    case "workspace": {
      const row = handle
        .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspace WHERE workspace_id = ?`)
        .get(id);
      return row === undefined ? undefined : toWorkspaceRow(row);
    }
  }
}

/**
 * Internal whole-table reads — the Phase 5 divergence comparison needs every
 * row, not a lookup. Exported from this module but **not** from
 * `src/index.ts`.
 */
export function readAllCodebases(db: StateDatabase): readonly CodebaseRow[] {
  const rows = internalHandle(db)
    .prepare(`SELECT ${CODEBASE_COLUMNS} FROM codebase ORDER BY codebase_id`)
    .all();
  return rows.map((row) => toCodebaseRow(row));
}

export function readAllRepositories(db: StateDatabase): readonly RepositoryRow[] {
  const rows = internalHandle(db)
    .prepare(`SELECT ${REPOSITORY_COLUMNS} FROM repository ORDER BY repository_id`)
    .all();
  return rows.map((row) => toRepositoryRow(row));
}

export function readAllWorkspaces(db: StateDatabase): readonly WorkspaceRow[] {
  const rows = internalHandle(db)
    .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspace ORDER BY workspace_id`)
    .all();
  return rows.map((row) => toWorkspaceRow(row));
}
