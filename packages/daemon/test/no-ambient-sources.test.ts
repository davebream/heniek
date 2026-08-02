/**
 * Determinism gate for `@heniek/daemon` (design C10, plan Task 3 Step 4).
 *
 * The daemon is the one package in this repo that legitimately *needs* the
 * forbidden primitives — it binds a socket, MACs a credential, and reads the
 * clock. C10's answer is not to ban them but to confine them: every one of
 * them lives under `src/runtime/**`, on a declared allowlist, and nowhere
 * else. This scan is what makes that claim checkable rather than aspirational.
 *
 * `FORBIDDEN_PATTERN` mirrors `packages/conformance/test/no-wall-clock.test.ts`
 * byte-for-byte and then **extends** it with `node:crypto` and
 * `process.platform`, which that pattern does not cover. The duplication is
 * deliberate and matches the precedent set by
 * `packages/state/test/no-ambient-sources.test.ts`: each package owns its own
 * scan and its own copy of the pattern, at the cost of ~20 duplicated lines
 * and *zero* cross-package coupling. Importing `FORBIDDEN_PATTERN` from
 * `@heniek/conformance` by any path is a recorded no-coupling decision.
 *
 * Three assertions, per C10:
 *
 * 1. every non-exempt `src/**.ts` file is clean;
 * 2. the scan is non-vacuous (it actually looked at files);
 * 3. the exemption set is **exactly** `EXPECTED_EXEMPTIONS` — set equality,
 *    not a numeric cap. A count bound cannot express "these files and no
 *    others", which is the property the carve-out actually needs.
 *
 * At this phase `EXPECTED_EXEMPTIONS` is **empty**: `src/runtime/**` does not
 * exist yet, so the gate proves the carve-out has not been pre-widened ahead
 * of the code that will justify it. Phase 5 lands the 11 adapters and adds
 * them here explicitly, one line per file.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = resolve(packageRoot, "src");

/**
 * Mirrors `packages/conformance/test/no-wall-clock.test.ts`'s
 * `FORBIDDEN_PATTERN`, plus the two families that pattern omits and C10
 * requires: `node:crypto` (the MAC/credential primitives, which belong in
 * `src/runtime/mac.ts`) and `process.platform` (the boot-witness probe,
 * which belongs in `src/runtime/host-witness.ts`).
 */
const FORBIDDEN_PATTERN =
  /\bDate\.now\b|\bMath\.random\b|randomUUID|process\.hrtime\b|process\.uptime\b|new Date\(\s*\)|(?<!new )\bDate\(|performance\.now\(\)|setTimeout\([^,]*,\s*(?!0\s*[,)])|setInterval\(|fetch\(|node:http\b|node:https\b|node:net\b|node:dgram\b|node:crypto\b|process\.platform\b|undici/;

/**
 * Files permitted to trip the pattern, as `src`-relative paths. **Empty by
 * design at this phase** — see the header. Phase 5 adds `runtime/…` entries
 * here as each adapter lands.
 */
const EXPECTED_EXEMPTIONS: readonly string[] = [];

/**
 * Non-vacuity floor. The package has 7 eligible `src` files at the end of
 * Phase 2; this bound is the honest current count, and per the plan it is
 * **raised, never lowered** as Phase 3 and Phase 5 add sources. A scan whose
 * `srcRoot` were wrong would list zero files and otherwise pass silently.
 */
const MINIMUM_SCANNED_FILES = 7;

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => resolve(entry.parentPath, entry.name));
}

function relativeToSrc(file: string): string {
  return file.slice(srcRoot.length + 1);
}

async function findOffenders(): Promise<{ offenders: string[]; scanned: number }> {
  const files = await listTypeScriptFiles(srcRoot);
  const offenders: string[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (FORBIDDEN_PATTERN.test(content)) {
      offenders.push(relativeToSrc(file));
    }
  }

  return { offenders: offenders.sort(), scanned: files.length };
}

describe("determinism gate — ambient sources are confined to src/runtime/** (design C10)", () => {
  it("no non-exempt src file reaches for a forbidden primitive", async () => {
    const { offenders } = await findOffenders();

    const unexpected = offenders.filter((file) => !EXPECTED_EXEMPTIONS.includes(file));
    expect(unexpected).toEqual([]);
  });

  it("the scan is non-vacuous", async () => {
    const { scanned } = await findOffenders();

    expect(scanned).toBeGreaterThanOrEqual(MINIMUM_SCANNED_FILES);
  });

  it("the exemption set is exactly the declared allowlist, neither wider nor narrower", async () => {
    const { offenders } = await findOffenders();

    // Set equality in both directions. A file that stops needing its
    // exemption must be removed from the allowlist in the same change that
    // makes it clean, or the carve-out silently keeps a permission the code
    // no longer earns.
    expect(offenders).toEqual([...EXPECTED_EXEMPTIONS].sort());
  });

  it("the carve-out has not been pre-widened ahead of the code that justifies it", async () => {
    // `src/runtime/**` lands in Phase 5. Until then the allowlist must be
    // empty — this is the assertion that fails loudly if someone adds an
    // exemption "in advance".
    expect(EXPECTED_EXEMPTIONS).toEqual([]);
  });
});

describe("determinism gate — negative controls", () => {
  it("the pattern matches everything it claims to forbid", () => {
    // Without this, a regex that silently stopped matching would make the
    // scan above pass vacuously.
    expect(FORBIDDEN_PATTERN.test("const t = Date.now();")).toBe(true);
    expect(FORBIDDEN_PATTERN.test("Math.random()")).toBe(true);
    expect(FORBIDDEN_PATTERN.test("randomUUID()")).toBe(true);
    expect(FORBIDDEN_PATTERN.test('import net from "node:net";')).toBe(true);
    expect(FORBIDDEN_PATTERN.test('import { createHmac } from "node:crypto";')).toBe(true);
    expect(FORBIDDEN_PATTERN.test('if (process.platform === "linux") {}')).toBe(true);
    expect(FORBIDDEN_PATTERN.test("setInterval(tick, 1000)")).toBe(true);
    expect(FORBIDDEN_PATTERN.test("setTimeout(tick, 1000)")).toBe(true);
    expect(FORBIDDEN_PATTERN.test("await fetch(url)")).toBe(true);
  });

  it("the pattern does not match the injected-port style the daemon actually uses", () => {
    expect(FORBIDDEN_PATTERN.test("const iso = clock.nowIso();")).toBe(false);
    expect(FORBIDDEN_PATTERN.test("const bytes = randomSource.bytes(16);")).toBe(false);
    expect(FORBIDDEN_PATTERN.test("macProvider.constantTimeEqual(a, b)")).toBe(false);
    expect(FORBIDDEN_PATTERN.test("await socketBinder.listen(path)")).toBe(false);
  });

  it("is conservative about zero-delay timers, which the design permits but the pattern still flags", () => {
    // The mirrored pattern tries to exempt `setTimeout(fn, 0)` via a negative
    // lookahead, but `\s*` before it backtracks to consume nothing, the
    // lookahead then compares against the space rather than the `0`, and the
    // alternative matches anyway. So the gate is stricter than design C10:
    // it rejects a zero-delay yield the design would allow.
    //
    // Recorded rather than fixed. The pattern is mirrored byte-for-byte from
    // `packages/conformance/test/no-wall-clock.test.ts` on purpose, and
    // diverging here would silently fork two copies that are supposed to be
    // identical. No daemon source uses a zero-delay timer, so the extra
    // strictness costs nothing today; a file that needs one must either be
    // exempted explicitly or the shared pattern fixed in its own change.
    expect(FORBIDDEN_PATTERN.test("setTimeout(resolve, 0)")).toBe(true);
  });
});
