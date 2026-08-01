/**
 * Determinism scan for `@heniek/state` (design D14, X2; plan Task 5.5).
 *
 * The sibling implementation is
 * `packages/conformance/test/no-wall-clock.test.ts`, and `FORBIDDEN_PATTERN`
 * below mirrors that file's pattern byte-for-byte. **The duplication is
 * deliberate**, decided at round-1 review (open question 2 / M8 / P4): each
 * package owns its own scan and its own copy of the pattern, at a cost of
 * ~20-30 duplicated lines and *zero* cross-package coupling. `@heniek/state`
 * takes no dependency — workspace or third-party — on `@heniek/conformance`,
 * and `packages/conformance/**` is not edited at all to support this file.
 *
 * The same trade-off is already made for the seeded splitmix32 generator in
 * `test/helpers/determinism.ts`, which mirrors
 * `packages/conformance/src/kernel/seed.ts` by local copy for the same reason.
 *
 * *Rejected:* importing `FORBIDDEN_PATTERN` from `@heniek/conformance` by any
 * path, relative or package-specifier. *Also rejected (D14):* widening the
 * conformance test's own `srcRoot` to reach across packages — that would give
 * `@heniek/conformance` a test that fails because of a *different* package's
 * source, landing the failure in the wrong place.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = resolve(packageRoot, "src");

/**
 * Mirrors `packages/conformance/test/no-wall-clock.test.ts`'s
 * `FORBIDDEN_PATTERN`. Covers three families of non-determinism plus X2's
 * network-access exclusion: wall-clock/random sources, timers with a
 * non-zero delay, and anything that could reach outside the process.
 */
const FORBIDDEN_PATTERN =
  /\bDate\.now\b|\bMath\.random\b|randomUUID|process\.hrtime\b|process\.uptime\b|new Date\(\s*\)|(?<!new )\bDate\(|performance\.now\(\)|setTimeout\([^,]*,\s*(?!0\s*[,)])|setInterval\(|fetch\(|node:http\b|node:https\b|node:net\b|node:dgram\b|undici/;

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => resolve(entry.parentPath, entry.name));
}

describe("no wall-clock, random, or network sources under src/ (D14, X2)", () => {
  it("every src/**.ts file is free of ambient non-determinism", async () => {
    const files = await listTypeScriptFiles(srcRoot);
    const offenders: string[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (FORBIDDEN_PATTERN.test(content)) {
        offenders.push(file.slice(packageRoot.length + 1));
      }
    }

    expect(offenders).toEqual([]);

    // Non-vacuity: a wrong `srcRoot` or a glob that matched nothing would
    // otherwise report zero offenders and pass. The package has ~21 eligible
    // src files; 15 leaves headroom without coupling this bound to the exact
    // count.
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it("the pattern actually matches the sources it claims to forbid (negative control)", () => {
    // Guards against a pattern that silently stopped matching — without this,
    // a broken regex would make the scan above pass vacuously.
    expect(FORBIDDEN_PATTERN.test("const t = Date.now();")).toBe(true);
    expect(FORBIDDEN_PATTERN.test("Math.random()")).toBe(true);
    expect(FORBIDDEN_PATTERN.test('import http from "node:http";')).toBe(true);
    expect(FORBIDDEN_PATTERN.test("await fetch(url)")).toBe(true);
    expect(FORBIDDEN_PATTERN.test("const iso = clock.nowIso();")).toBe(false);
  });
});

// `test/**` is deliberately NOT scanned. Phase 6's crash harness spawns a real
// subprocess and waits on it in real time, which is the same honesty exemption
// `no-wall-clock.test.ts` grants `src/smoke/**`: a test that proves durability
// against SIGKILL cannot do so on an injected clock.
