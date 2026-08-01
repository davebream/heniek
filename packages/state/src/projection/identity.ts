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
import { toSafeInteger, toText } from "../database/pragma.js";

export interface CodebaseRow {
  readonly codebaseId: string;
  readonly revision: number;
  readonly lastEventSequence: number;
  readonly updatedAt: string;
}

export interface RepositoryRow {
  readonly repositoryId: string;
  readonly codebaseId: string;
  readonly revision: number;
  readonly lastEventSequence: number;
  readonly updatedAt: string;
}

export interface WorkspaceRow {
  readonly workspaceId: string;
  readonly codebaseId: string;
  readonly revision: number;
  readonly lastEventSequence: number;
  readonly updatedAt: string;
}

const CODEBASE_COLUMNS = "codebase_id, revision, last_event_sequence, updated_at";
const REPOSITORY_COLUMNS = "repository_id, codebase_id, revision, last_event_sequence, updated_at";
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
  };
}

export function toRepositoryRow(raw: Record<string, unknown>): RepositoryRow {
  return {
    repositoryId: toText(raw.repository_id, "repository.repository_id"),
    codebaseId: toText(raw.codebase_id, "repository.codebase_id"),
    revision: toSafeInteger(raw.revision, "repository.revision"),
    lastEventSequence: toSafeInteger(raw.last_event_sequence, "repository.last_event_sequence"),
    updatedAt: toText(raw.updated_at, "repository.updated_at"),
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
