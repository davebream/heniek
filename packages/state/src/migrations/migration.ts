/**
 * The `Migration` shape and the append-only guard (design D2, D3, C1).
 *
 * There is deliberately no `down` member on `Migration` — forward-only is
 * enforced by the type itself, not by a convention that a future migration
 * could quietly ignore (D2.2).
 */

import { createHash } from "node:crypto";
import { MigrationError } from "../errors.js";

export interface Migration {
  /** 1-based, contiguous, strictly ascending. */
  readonly version: number;
  /** Stable slug; appears in the E1 manifest and must never be edited once released. */
  readonly name: string;
  /** Executed in order, inside one transaction with the version bump. */
  readonly statements: readonly string[];
}

const AUTOINCREMENT_PATTERN = /\bAUTOINCREMENT\b/i;

/**
 * A substring test, not a SQL parse (deliberate over-approximation, plan
 * Task 2.1). It would also reject a legitimate statement whose *string
 * literal* happens to contain `--` or `/*`; that is accepted, because it buys
 * a one-line guarantee that the fingerprint's normal form never has to strip
 * comments. A future migration that trips this must be rewritten, not have
 * this check loosened into a partial SQL parser.
 */
const COMMENT_PATTERN = /--|\/\*/;

/**
 * Throws `MigrationError` on the first violation found. Runs at module load
 * of `migrations/list.ts`, and again in `test/migrations.test.ts` against
 * deliberately mutated copies (C1).
 */
export function assertAppendOnly(migrations: readonly Migration[]): void {
  // `migrations[0]` rather than `.at(0)` reads the same under
  // `noUncheckedIndexedAccess`; either way the result is `Migration |
  // undefined` and must be narrowed before use.
  const first = migrations[0];
  if (first === undefined) {
    throw new MigrationError(0, -1, "the migration list must not be empty");
  }
  if (first.version !== 1) {
    throw new MigrationError(first.version, -1, "the first migration must be version 1");
  }

  const seenNames = new Set<string>();
  let previousVersion = 0;
  for (const migration of migrations) {
    const { version, name, statements } = migration;
    if (version !== previousVersion + 1) {
      throw new MigrationError(
        version,
        -1,
        `migration versions must be contiguous and strictly ascending — expected ` +
          `${previousVersion + 1}, got ${version}`,
      );
    }
    if (seenNames.has(name)) {
      throw new MigrationError(version, -1, `duplicate migration name: ${name}`);
    }
    seenNames.add(name);
    if (statements.length === 0) {
      throw new MigrationError(version, -1, "migration has no statements");
    }
    for (const [index, statement] of statements.entries()) {
      if (AUTOINCREMENT_PATTERN.test(statement)) {
        throw new MigrationError(
          version,
          index,
          "AUTOINCREMENT is banned in migration statements (design D3)",
        );
      }
      if (COMMENT_PATTERN.test(statement)) {
        throw new MigrationError(
          version,
          index,
          "migration statements must not contain SQL comments (-- or /*)",
        );
      }
    }
    previousVersion = version;
  }
}

/**
 * sha256 hex over each statement whitespace-normalised (`replace(/\s+/g,
 * " ").trim()`) then joined by `"\n"` — the same normal form the schema
 * fingerprint's `declared` digest uses, so a whitespace-only reflow of a
 * shipped migration does not trip this pin while a semantic edit does.
 *
 * **This normal form collapses whitespace inside string literals too**
 * (issue #7, Phase 2 fix G7): `replace(/\s+/g, " ")` has no notion of quoting,
 * so changing `'state_event is append-only'` to `'state_event  is
 * append-only'` (an extra space inside the literal) does not trip this pin,
 * nor `declared`'s identical normal form — both pins are blind to that
 * specific edit. This blind spot is shared by all three pins in this
 * package (`migrationStatementHash`, `schemaFingerprint().structural`'s
 * trigger/view DDL text, and `schemaFingerprint().declared`). The covering
 * check is `schema-constraints.test.ts`'s verbatim message assertions
 * (`toBe("state_event is append-only")` at the UPDATE and DELETE cases) —
 * those run the trigger and assert its *raised* message character-for-
 * character, which a collapsed-whitespace literal would fail.
 */
export function migrationStatementHash(migration: Migration): string {
  const normalised = migration.statements
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .join("\n");
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}
