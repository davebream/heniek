import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = resolve(packageRoot, "src");

/**
 * Exported so the negative-control test below (and any future consumer) can
 * assert against the exact pattern this suite scans with, rather than a
 * hand-copied duplicate that could silently drift from the real one.
 *
 * Covers three families of non-determinism (C1) plus X2's network-access
 * exclusion:
 *  - wall-clock/random sources: `Date.now`, `Math.random`, `randomUUID`,
 *    `process.hrtime`, `process.uptime`, `new Date()`, a bare `Date(...)`
 *    call not preceded by `new` (which — per spec — ignores any arguments
 *    and always returns the current date/time regardless), `performance.now()`;
 *  - timers: `setTimeout` with a non-zero (or non-literal-zero) delay,
 *    `setInterval` unconditionally (there is no zero-delay exception for a
 *    recurring timer);
 *  - network sources (X2 — "no network access in deterministic test
 *    suites" needs an actual enforcement point, not just a policy
 *    statement): `fetch(`, and the `node:http`/`node:https`/`node:net`/
 *    `node:dgram` built-ins and the `undici` package, any of which could
 *    reach outside the process non-deterministically.
 */
export const FORBIDDEN_PATTERN =
  /\bDate\.now\b|\bMath\.random\b|randomUUID|process\.hrtime\b|process\.uptime\b|new Date\(\s*\)|(?<!new )\bDate\(|performance\.now\(\)|setTimeout\([^,]*,\s*(?!0\s*[,)])|setInterval\(|fetch\(|node:http\b|node:https\b|node:net\b|node:dgram\b|undici/;

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => resolve(entry.parentPath, entry.name));
}

describe("no wall-clock or non-deterministic sources under src/ (C1)", () => {
  it("src/**, excluding src/smoke/** (a real process, real time, is honest there), has none", async () => {
    const files = await listTypeScriptFiles(srcRoot);
    const offenders: string[] = [];

    for (const file of files) {
      // Separator-independent exemption check: `relative(srcRoot, file)`
      // split on the platform's own `sep` rather than string-matching a
      // hardcoded `/`, so this scan behaves identically on a POSIX or
      // Windows checkout. Only files whose *first* path segment under
      // `src/` is exactly `smoke` are exempted — a file directly under
      // `src/` (zero segments before its own filename) is never exempted,
      // so the exemption cannot silently widen to cover the rest of `src/`.
      const segments = relative(srcRoot, file).split(sep);
      if (segments[0] === "smoke") {
        // Exempted: `src/smoke/**` bundles a genuinely-real subprocess
        // adapter (real process spawn, real stream I/O, real SIGTERM
        // cancellation) — it is explicitly allowed to use wall-clock time
        // and bounded real timeouts, per design §6 and plan Phase 7.2.
        continue;
      }
      const content = await readFile(file, "utf8");
      if (FORBIDDEN_PATTERN.test(content)) {
        offenders.push(file);
      }
    }

    expect(
      offenders,
      `wall-clock/non-deterministic source found in: ${offenders.join(", ")}`,
    ).toEqual([]);
    // A lower bound so this scan cannot pass vacuously by scanning zero
    // files (e.g. a wrong `srcRoot`, a `readdir` permission error silently
    // swallowed elsewhere, or a future refactor emptying `src/` of eligible
    // files). The package currently has ~30 eligible files outside
    // `src/smoke/**`; 20 leaves headroom without being a tight coupling to
    // the exact count.
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it.each([
    ["Date.now", "const t = Date.now();"],
    ["Math.random", "const r = Math.random();"],
    ["randomUUID", 'import { randomUUID } from "node:crypto";'],
    ["process.hrtime", "const t = process.hrtime();"],
    ["process.uptime", "const t = process.uptime();"],
    ["new Date()", "const now = new Date();"],
    ["bare Date( not preceded by new", "const now = Date(2026, 0, 1);"],
    ["performance.now()", "const t = performance.now();"],
    ["setTimeout with non-zero delay", "setTimeout(fn, 100);"],
    ["setInterval", "setInterval(fn, 100);"],
    ["fetch(", 'fetch("https://example.invalid");'],
    ["node:http", 'import { createServer } from "node:http";'],
    ["node:https", 'import { request } from "node:https";'],
    ["node:net", 'import { createConnection } from "node:net";'],
    ["node:dgram", 'import { createSocket } from "node:dgram";'],
    ["undici", 'import { request } from "undici";'],
  ])("FORBIDDEN_PATTERN matches a synthetic %s construct", (_label, sample) => {
    // Negative control: without this, a broken/narrowed FORBIDDEN_PATTERN
    // (e.g. one accidentally scoped to nothing, or missing an alternative
    // during a future edit) would still let the scan above pass — an
    // empty `offenders` array is indistinguishable from "nothing
    // forbidden was present" and "the pattern can no longer match
    // anything". This test fails the moment the pattern stops matching
    // any one of these banned constructs.
    expect(FORBIDDEN_PATTERN.test(sample)).toBe(true);
  });
});
