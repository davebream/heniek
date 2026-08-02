/**
 * `listArtifacts` — Phase 5's artifact inventory pass (plan Task 5.2, design
 * D5). Reads every `artifact` row and re-verifies its content hash against
 * the bytes currently at its `relativePath`, reporting `verified: boolean`
 * per row rather than throwing on a mismatch — a tampered or vanished blob
 * is exactly the kind of fact this pass exists to surface, not to hide by
 * failing the whole call. This is what produces the issue's OR-16 evidence
 * (artifact inventory with verified hashes).
 *
 * Every row is listed regardless of `verified` — an unverifiable row is
 * still a row this database attests to, and dropping it from the report
 * would make the inventory undercount rather than flag the problem.
 *
 * **Why this can legitimately report `verified: false` even with no
 * malicious actor involved:** `complete-stage.ts`'s S2 assertion (its own
 * docblock, J2 — Phase 4 fix cycle, post-Phase-4 adversarial review)
 * documents a residual TOCTOU window between the assertion and `COMMIT`,
 * and again between `COMMIT` and the receipt fd's own close — the pinned fd
 * keeps bytes alive only for as long as this process holds it open, never
 * the directory entry a later reader resolves. `listArtifacts` is that
 * later reader; a `false` here is the detection this package offers for
 * that window, not proof of a bug in how the row was written.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { StateDatabase } from "../database/open.js";
import { type ArtifactState, loadStoredProjectionState } from "../projection/state.js";
import type { ArtifactFileSystem } from "./file-system.js";
import { type ArtifactStore, internalArtifactFileSystem } from "./store.js";

const READ_CHUNK_BYTES = 64 * 1024;

/** One `artifact` row plus the re-verification `listArtifacts` performed against it. */
export interface ArtifactInventoryRow extends ArtifactState {
  /** `true` only if the bytes currently at `relativePath` hash to `contentHash`; `false` on any mismatch, missing file, or read failure. */
  readonly verified: boolean;
}

/**
 * Re-hashes the file at `absolutePath` through the `ArtifactFileSystem`
 * port, mirroring `publish.ts`'s `hashAndValidate` read loop. Returns
 * `undefined` on any failure (open, read, or close) — the caller treats
 * that identically to a hash mismatch (`verified: false`); a missing or
 * unreadable blob is exactly as "not verified" as a tampered one, and this
 * pass's job is to report that fact, not to distinguish its cause.
 */
function reHashFile(fs: ArtifactFileSystem, absolutePath: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openReadOnly(absolutePath);
  } catch {
    return undefined;
  }
  try {
    const hash = createHash("sha256");
    const buffer = new Uint8Array(READ_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const bytesRead = fs.readAt(fd, buffer, position);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  } finally {
    try {
      fs.close(fd);
    } catch {
      // Best-effort — mirrors every other close-in-finally helper in this
      // package's artifact modules; a close failure here has no further
      // recourse and must not mask whatever the read loop already decided.
    }
  }
}

/**
 * Every `artifact` row, each carrying a fresh `verified` re-check against
 * `store`. Deterministic given a fixed database and filesystem state — no
 * wall-clock, randomness, or network source (package invariant).
 */
export function listArtifacts(
  db: StateDatabase,
  store: ArtifactStore,
): readonly ArtifactInventoryRow[] {
  const fs = internalArtifactFileSystem(store);
  const state = loadStoredProjectionState(db);

  return Object.values(state.artifacts)
    .slice()
    .sort((a, b) => a.artifactId.localeCompare(b.artifactId))
    .map((row) => {
      const actualHash = reHashFile(fs, join(store.root, row.relativePath));
      return { ...row, verified: actualHash !== undefined && actualHash === row.contentHash };
    });
}
