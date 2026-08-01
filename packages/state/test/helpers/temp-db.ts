/**
 * Real-filesystem temp directory helpers for `@heniek/state` tests (plan
 * §0.6, Task 1.8). **Never `:memory:`** — an in-memory database reports
 * `journal_mode: memory` regardless of what `openStateDatabase` asks for,
 * so every WAL, sidecar, and permission assertion this package's tests
 * make would be vacuous against it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_DIR_PREFIX = "heniek-state-";

/**
 * Creates a real temporary directory via `mkdtemp`, passes its path to
 * `fn`, and removes it afterwards regardless of whether `fn` throws.
 */
export async function withTempDir<T>(fn: (directory: string) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Creates a fresh temporary directory and returns it alongside a
 * `state.sqlite` path inside it. Unlike `withTempDir`, cleanup is the
 * caller's responsibility (typically an `afterEach` calling
 * `rm(directory, { recursive: true, force: true })`) — this is the shape a
 * `beforeEach`/`afterEach` pair needs, where the directory must outlive a
 * single callback.
 */
export async function makeTempDbPath(): Promise<{
  readonly directory: string;
  readonly path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  return { directory, path: join(directory, "state.sqlite") };
}
