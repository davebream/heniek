/**
 * Determinism gate for `@heniek/pipeline`.
 *
 * Unlike `@heniek/daemon` and `@heniek/state`, which confine their ambient
 * primitives to a declared allowlist, this package has **no allowlist at
 * all**: reading a pipeline document is a pure function of the text and the
 * options, and it stays one. A clock, a random id, a socket, or a filesystem
 * read anywhere under `src/` would break the property every other test in
 * this package depends on — that the same document always produces the same
 * bytes, on any machine, in any order, at any time.
 *
 * `FORBIDDEN_PATTERN` mirrors the daemon's copy, minus the `node:crypto` and
 * `process.platform` members it added for its own boundary and plus the
 * filesystem, which this package must never touch. The duplication is
 * deliberate and follows the precedent set by
 * `packages/state/test/no-ambient-sources.test.ts`: each package owns its own
 * scan, at the cost of a duplicated regex and zero cross-package coupling.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = resolve(packageRoot, "src");

const FORBIDDEN_PATTERN =
  /\bDate\.now\b|\bMath\.random\b|randomUUID|process\.hrtime\b|process\.uptime\b|new Date\(\s*\)|(?<!new )\bDate\(|performance\.now\(\)|setTimeout\(|setInterval\(|fetch\(|node:http\b|node:https\b|node:net\b|node:dgram\b|node:fs\b|node:os\b|node:child_process\b|process\.env\b|undici/;

/**
 * Non-vacuity floor: the total `.ts` file count under `src/`. Raised, never
 * lowered. A scan whose `srcRoot` were wrong would list zero files and
 * otherwise pass in silence.
 */
const MINIMUM_SCANNED_FILES = 22;

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

describe("no ambient sources", () => {
  it("reads no clock, no entropy, no socket, no filesystem, and no environment", async () => {
    const files = await listTypeScriptFiles(srcRoot);
    const offenders: string[] = [];
    for (const file of files) {
      const contents = await readFile(join(srcRoot, file), "utf8");
      // Comments are stripped first: this file's own prose, and the
      // explanatory comments in `src/`, legitimately name the primitives they
      // are explaining why the package does not use.
      const code = contents.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (FORBIDDEN_PATTERN.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders, `ambient sources in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("scanned the files it was supposed to scan", async () => {
    const files = await listTypeScriptFiles(srcRoot);
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_SCANNED_FILES);
  });
});
