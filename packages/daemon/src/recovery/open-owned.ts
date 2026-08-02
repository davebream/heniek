/**
 * `openOwnedStateDatabase` — the one place `@heniek/daemon` is allowed to
 * open `@heniek/state`'s database (design C11, plan Task 4 Step 6).
 *
 * Requires a held `LockHandle` and re-confirms it with `assertStillHeld()`
 * before ever touching the filesystem, then delegates to `openStateDatabase`
 * and `runMigrations` **unchanged** — `packages/state` is not modified
 * behaviourally by this component, only its docblocks (Phase 7, DOC-c).
 *
 * The `SingleWriterToken` brand design C11 names lives *here*, inside
 * `@heniek/daemon`, not as a required parameter of `openStateDatabase` —
 * promoting it there is design Alternative N, rejected for scope (OR-15).
 * Concretely: this function's own signature *requiring* a `LockHandle` is
 * the brand — there is no way to reach `openStateDatabase`/`runMigrations`
 * through this module without first holding a claim, and `assertStillHeld()`
 * re-checks that claim is still ours immediately before either call.
 */

import {
  type OpenStateDatabaseOptions,
  openStateDatabase,
  runMigrations,
  type StateDatabase,
} from "@heniek/state";
import type { LockHandle } from "../lifecycle/guard.js";

export function openOwnedStateDatabase(
  lock: LockHandle,
  options: OpenStateDatabaseOptions,
): StateDatabase {
  lock.assertStillHeld();
  const db = openStateDatabase(options);
  runMigrations(db);
  return db;
}
