/**
 * The artifact store's construction and layout (plan Task 3.3, R5/I7 /
 * design D5a). `createArtifactStoreInternal` is **module-visible only** —
 * exported from this module but never from `src/index.ts`, mirroring
 * `openStateDatabaseInternal`'s package-private-by-construction discipline
 * (`database/open.ts`).
 *
 * **Recovery-sweep policy (I7).** `createArtifactStore` never runs an
 * unconditional, no-age-floor sweep of `incoming/` — that would unlink
 * another **concurrent process's** in-flight publish (cross-process
 * single-writer enforcement is chartered to Q008, out of scope here). The
 * optional `autoRecover: { minAgeMs }` runs a **gated** sweep — only
 * `incoming/` entries whose `lstat().mtimeMs` is at least `minAgeMs` old,
 * measured against the injected `Clock` (never a direct wall-clock read, invariant 4) —
 * before the store is returned. Omit `autoRecover` and no sweep runs at
 * all; the caller is expected to invoke Task 5.1's `recoverArtifacts`
 * explicitly from an operator entry point for the unconditional mode.
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
  /** Gated automatic `incoming/` sweep run before the store is returned (R5/I7/D5a). Omit to run no sweep at all. */
  readonly autoRecover?: { readonly minAgeMs: number };
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

export function internalArtifactClock(store: ArtifactStore): Clock {
  return internals(store, "internalArtifactClock").clock;
}

export function internalArtifactIds(store: ArtifactStore): IdGenerator {
  return internals(store, "internalArtifactIds").ids;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * The gated sweep (R5/I7/D5a). Removes only `incoming/` entries at least
 * `minAgeMs` old, measured as `nowMs - lstat().mtimeMs`, where `nowMs`
 * comes from the store's injected `Clock` — never a direct wall-clock read. A failure to
 * `lstat` or `unlink` a given entry is swallowed as best-effort **except**
 * `ENOENT` races with a legitimately-vanished entry, which is not an
 * error at all; Task 5.1's `recoverArtifacts` is where a caller who wants
 * failures surfaced (as `ArtifactRecoveryError`) should look — this
 * construction-time sweep is deliberately silent so a transient sweep
 * failure never prevents `createArtifactStore` from returning a usable
 * store.
 */
function sweepIncomingGated(
  fs: ArtifactFileSystem,
  incomingDir: string,
  clock: Clock,
  minAgeMs: number,
): void {
  const nowMs = Date.parse(clock.nowIso());
  let entries: readonly string[];
  try {
    entries = fs.readdir(incomingDir);
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = join(incomingDir, entry);
    let mtimeMs: number;
    try {
      mtimeMs = fs.lstat(entryPath).mtimeMs;
    } catch (error) {
      if (isEnoent(error)) {
        continue;
      }
      throw error;
    }
    if (nowMs - mtimeMs < minAgeMs) {
      continue;
    }
    try {
      fs.unlink(entryPath);
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }
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

  if (options.autoRecover !== undefined) {
    sweepIncomingGated(fs, incomingDir, options.clock, options.autoRecover.minAgeMs);
  }

  const store: ArtifactStore = { root, incomingDir, blobsDir };
  HANDLES.set(store, { fs, clock: options.clock, ids: options.ids });
  return store;
}

/** Creates (idempotently) the `incoming/` and `blobs/sha256/` layout under `options.root` and returns a handle. */
export function createArtifactStore(options: ArtifactStoreOptions): ArtifactStore {
  return createArtifactStoreInternal(options, createNodeArtifactFileSystem());
}
