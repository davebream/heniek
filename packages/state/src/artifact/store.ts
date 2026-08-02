/**
 * The artifact store's construction and layout (plan Task 3.3, R5/I7 /
 * design D5a). `createArtifactStoreInternal` is **module-visible only** —
 * exported from this module but never from `src/index.ts`, mirroring
 * `openStateDatabaseInternal`'s package-private-by-construction discipline
 * (`database/open.ts`).
 *
 * **Recovery-sweep policy (H1 fix, post-Phase-3 adversarial review).**
 * `createArtifactStore` never removes anything from `incoming/`, gated or
 * otherwise. An earlier revision shipped a gated `autoRecover: { minAgeMs }`
 * sweep here; it was removed because it was unsound in three independent
 * ways: (a) it compared the injected `Clock`'s `nowMs` against
 * `lstat().mtimeMs`, which is real kernel wall-clock time — under any real
 * (fake) `Clock` the two are in different time domains, so the gate was
 * either silently inert or, under clock skew, could unlink a live writer's
 * in-flight temp; (b) a malformed clock value made `NaN - mtimeMs < minAgeMs`
 * evaluate `false`, unlinking everything in `incoming/` rather than nothing
 * (fail-open); (c) `mtime` cannot distinguish "abandoned temp" from "slow
 * live writer" at any floor that is simultaneously safe and useful.
 * Recovery is now an **explicit** operation, chartered to Phase 5's
 * `recoverArtifacts`, invoked deliberately by an operator entry point that
 * documents the single-writer-lock precondition — never wired to the
 * automatic on-open path.
 *
 * **Container symlink/type discipline (H2).** `mkdir` tolerates a
 * pre-existing symlink at its target path (it resolves and treats the
 * symlink's target as "already there"). Without a follow-up check, a
 * `root` whose `incoming/` or `blobs/sha256/` segment is a symlink to an
 * unrelated directory would be silently accepted, and any caller that later
 * lists or writes into it would be operating on that unrelated directory
 * instead. `createArtifactStoreInternal` therefore `lstat`s each container
 * after `mkdir` and refuses (never falls through) unless it is a real,
 * non-symlink directory.
 *
 * **`clock` accessor deliberately absent — final, non-negotiable for this
 * fix cycle (Phase 4/5 fix cycle, dispatch-level decision).**
 * `ArtifactStoreOptions.clock` is still accepted and stored — every caller
 * already threads a `Clock` through `createArtifactStore` for the store
 * handle's lifetime. No `internalArtifactClock(store)` accessor exists, and
 * none should be added: `recoverArtifacts` (`artifact/recover.ts`) has
 * exactly one mode (unconditional `incoming/` removal), gated instead by a
 * documented single-writer-lock precondition, never by comparing this
 * store's `Clock` against real kernel `mtimeMs` — that comparison is the
 * exact pattern this fix cycle rejects, for the same three reasons this
 * docblock's H1 paragraph above already gives for the automatic on-open
 * sweep. Whether the caller opts into the comparison explicitly or the
 * sweep runs automatically does not change that `Clock` and `mtimeMs` are
 * different time domains. Reintroducing this accessor reopens exactly the
 * hole H1 closed; do not reintroduce it.
 */

import { join } from "node:path";
import type { Clock, IdGenerator } from "../determinism.js";
import { StateStoreError } from "../errors.js";
import { type ArtifactFileSystem, createNodeArtifactFileSystem } from "./file-system.js";

const INCOMING_DIR_NAME = "incoming";
const BLOBS_DIR_SEGMENTS = ["blobs", "sha256"] as const;

export interface ArtifactStoreOptions {
  readonly root: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Opaque. Holds no filesystem port or determinism port as a visible member — reached only via the internal accessors below, mirroring `StateDatabase` (design D10). */
export interface ArtifactStore {
  readonly root: string;
  readonly incomingDir: string;
  readonly blobsDir: string;
}

interface Internals {
  readonly fs: ArtifactFileSystem;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const HANDLES = new WeakMap<ArtifactStore, Internals>();

function internals(store: ArtifactStore, what: string): Internals {
  const found = HANDLES.get(store);
  if (found === undefined) {
    throw new StateStoreError(`${what}: not a handle returned by createArtifactStore`);
  }
  return found;
}

/** INTERNAL — exported from this module but NOT from src/index.ts. Package-private by construction. */
export function internalArtifactFileSystem(store: ArtifactStore): ArtifactFileSystem {
  return internals(store, "internalArtifactFileSystem").fs;
}

export function internalArtifactIds(store: ArtifactStore): IdGenerator {
  return internals(store, "internalArtifactIds").ids;
}

/**
 * H2: refuses a container path that is not a real, non-symlink directory.
 * Called after `mkdir`, which itself tolerates (and so cannot be trusted to
 * reject) a pre-existing symlink at the target path.
 */
function assertRealDirectory(fs: ArtifactFileSystem, path: string): void {
  const stat = fs.lstat(path);
  if (stat.isSymbolicLink || !stat.isDirectory) {
    throw new StateStoreError(
      `artifact store container is not a real directory (refusing to operate on a symlink or non-directory): ${path}`,
    );
  }
}

/** INTERNAL — exported from this module but NOT from src/index.ts. Package-private by construction, mirroring `openStateDatabaseInternal`. */
export function createArtifactStoreInternal(
  options: ArtifactStoreOptions,
  fs: ArtifactFileSystem,
): ArtifactStore {
  const root = options.root;
  const incomingDir = join(root, INCOMING_DIR_NAME);
  const blobsDir = join(root, ...BLOBS_DIR_SEGMENTS);

  fs.mkdir(incomingDir);
  fs.mkdir(blobsDir);
  assertRealDirectory(fs, incomingDir);
  assertRealDirectory(fs, blobsDir);

  const store: ArtifactStore = { root, incomingDir, blobsDir };
  HANDLES.set(store, { fs, clock: options.clock, ids: options.ids });
  return store;
}

/** Creates (idempotently) the `incoming/` and `blobs/sha256/` layout under `options.root` and returns a handle. Never removes anything — see this module's docblock (H1). */
export function createArtifactStore(options: ArtifactStoreOptions): ArtifactStore {
  return createArtifactStoreInternal(options, createNodeArtifactFileSystem());
}
