/**
 * Determinism gate for `@heniek/daemon` (design C10, plan Task 3 Step 4;
 * exemption populated at plan Task 5 Step 10).
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
 * 1. every non-exempt `src/**.ts` file is clean — no file outside the
 *    allowlist trips `FORBIDDEN_PATTERN`;
 * 2. the scan is non-vacuous (it actually looked at files);
 * 3. **the set of files that actually exist under `src/runtime/` is exactly
 *    `EXPECTED_EXEMPTIONS`** — directory-membership set equality, not a
 *    numeric cap and not "every allowlisted file currently trips the
 *    pattern". A count bound cannot express "these files and no others",
 *    which is the property the carve-out needs, and directory membership is
 *    the only form of that check the eleven Phase 5 adapters can actually
 *    satisfy: `FORBIDDEN_PATTERN` is deliberately narrow (clock/random/
 *    network/crypto-specific), so `src/runtime/lock-filesystem.ts`
 *    (`node:fs` syscalls), `src/runtime/process-liveness.ts`
 *    (`process.kill`/`process.getuid`), `src/runtime/signals.ts`
 *    (`process.on`), `src/runtime/trace-sink.ts` (`process.stderr.write`),
 *    and `src/runtime/compose.ts` (no ambient primitive of its own — it
 *    only wires the others together) are all legitimately ambient without
 *    ever tripping this particular regex. An earlier draft of this gate
 *    required `offenders` to equal `EXPECTED_EXEMPTIONS` by *pattern-trip*
 *    set equality; that requirement is wrong once the allowlist contains a
 *    file whose ambient-ness this narrow pattern cannot see, and was
 *    replaced by this directory-membership form, which is also exactly
 *    what design C10's own wording asks for ("the set of files under
 *    `src/runtime/` equals an explicit allowlist"). Assertion 1 already
 *    gives the other, still-necessary direction — no *unauthorised*
 *    offender outside the allowlist — so nothing is lost.
 *
 * `EXPECTED_EXEMPTIONS` now names Phase 5's eleven `src/runtime/**` adapters
 * plus Q012's execution supervisor and Q021's durable scheduling supervisor,
 * whose clocks, timers and process witnesses are deliberately composed at the
 * same runtime boundary.
 * — one line per file, per the plan's allowlist table (plan Task 5, "the
 * gate asserts set equality against this list, so adding, removing, or
 * renaming a runtime file without updating the test is a hard failure").
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = resolve(packageRoot, "src");
const runtimeRoot = resolve(srcRoot, "runtime");

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
 * Files permitted to trip the pattern, as `src`-relative paths — the
 * eleven `src/runtime/**` adapters design C10 and plan Task 5 name: the
 * single composition root, the two socket adapters, the filesystem lock
 * adapter, the two identity probes, the clock, the CSPRNG source, the MAC
 * provider, the signal handlers, and the trace sink.
 */
const EXPECTED_EXEMPTIONS: readonly string[] = [
  "runtime/clock.ts",
  "runtime/compose.ts",
  "runtime/execution-service.ts",
  "runtime/host-witness.ts",
  "runtime/lock-filesystem.ts",
  "runtime/mac.ts",
  /*
   * The native bridge service (Q023). Genuinely ambient, unlike
   * stage-completion.ts above: `execFile` to resolve the repository's git
   * HEAD (mirrors scheduling-service.ts's own `repositoryHead`) and
   * `node:fs/promises#readFile` to read a submitted artifact off disk —
   * exactly the class of filesystem/process work `src/runtime/**` exists to
   * confine, not a borderline case.
   */
  "runtime/native-bridge-service.ts",
  /*
   * The pipeline runner coordinator (Q026). Ambient for the same reasons as
   * scheduling-service / native-bridge: `node:fs` for attempt runtime dirs and
   * result envelopes, plus `setTimeout` for bounded poll/deadline loops while
   * driving agent and command stage runners.
   */
  "runtime/pipeline-runner-service.ts",
  "runtime/process-liveness.ts",
  "runtime/random-source.ts",
  /*
   * Pure failure-classification helper for Q028 observation payloads. Listed
   * for directory-membership completeness; it imports only @heniek/pipeline
   * classifiers and has no ambient I/O.
   */
  "runtime/recovery-observation.ts",
  "runtime/scheduling-service.ts",
  "runtime/signals.ts",
  "runtime/socket-probe.ts",
  "runtime/socket-server.ts",
  /*
   * Q023's shared terminal path. It trips the pattern only on `node:crypto`,
   * and only to sha256 bytes it was handed — content addressing, not a
   * secret operation and not an ambient source: same input, same digest,
   * no clock, no entropy, no socket. It is listed here because assertion 3
   * is directory membership, so every file under `src/runtime/` must appear
   * whether or not its ambient-ness is real, and because the alternative —
   * moving it out of `src/runtime/` — would make assertion 1 flag it as an
   * unauthorised offender for the same blunt `node:crypto` match.
   */
  "runtime/stage-completion.ts",
  "runtime/trace-sink.ts",
];

/**
 * Non-vacuity floor. Raised, never lowered, as the package grows — this is
 * the total `.ts` file count under `src/` (exempt and non-exempt alike) as
 * of Phase 5, the eleven `src/runtime/**` adapters included. A scan whose
 * `srcRoot` were wrong would list zero files and otherwise pass silently.
 */
const MINIMUM_SCANNED_FILES = 40;

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

  it("the set of files that actually exist under src/runtime/ is exactly the declared allowlist", async () => {
    const runtimeFiles = await listTypeScriptFiles(runtimeRoot);
    const relative = runtimeFiles.map(relativeToSrc).sort();

    expect(relative).toEqual([...EXPECTED_EXEMPTIONS].sort());
  });

  it("the allowlist is non-empty and scoped to exactly one path segment, 'runtime'", () => {
    // The inverse of the pre-Phase-5 guard this test replaced: now that
    // `src/runtime/**` exists, an *empty* allowlist would be just as wrong
    // as an unscoped one — it would mean the carve-out exists but nothing
    // has actually been granted the exemption it exists to model.
    expect(EXPECTED_EXEMPTIONS.length).toBeGreaterThan(0);
    for (const file of EXPECTED_EXEMPTIONS) {
      const segments = file.split("/");
      expect(segments[0]).toBe("runtime");
      expect(segments).toHaveLength(2);
    }
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

describe("determinism gate — positive controls (plan Task 5 Falsifiability)", () => {
  it("reports an offender when a forbidden import sits directly under src/, zero segments before the filename", async () => {
    // Proves the exemption is first-path-segment-scoped and cannot widen
    // sideways: a file with an identical forbidden import, but placed
    // directly under `src/` instead of `src/runtime/`, must still be
    // reported — it is deliberately *not* added to `EXPECTED_EXEMPTIONS`.
    const strayPath = join(srcRoot, "__positive-control-outside-runtime.ts");
    writeFileSync(strayPath, 'import { createServer } from "node:net";\n');
    try {
      const { offenders } = await findOffenders();
      const unexpected = offenders.filter((file) => !EXPECTED_EXEMPTIONS.includes(file));
      expect(unexpected).toContain("__positive-control-outside-runtime.ts");
    } finally {
      rmSync(strayPath, { force: true });
    }
  });

  it("fails the runtime-membership assertion when an unused file is added to src/runtime/", async () => {
    // A stray `src/runtime/unused.ts` never trips FORBIDDEN_PATTERN (it is
    // empty), so it can never appear in `offenders` — assertion 1 alone
    // would stay green. Assertion 3 (directory membership) is what catches
    // it, which is exactly what this control proves.
    const strayPath = join(runtimeRoot, "unused.ts");
    writeFileSync(strayPath, "export {};\n");
    try {
      const runtimeFiles = await listTypeScriptFiles(runtimeRoot);
      const relative = runtimeFiles.map(relativeToSrc).sort();
      expect(relative).not.toEqual([...EXPECTED_EXEMPTIONS].sort());
      expect(relative).toContain("runtime/unused.ts");
    } finally {
      rmSync(strayPath, { force: true });
    }
  });

  it("src/runtime/ contains no other stray files after both controls clean up", () => {
    // A same-test-run sanity check, not a control of its own: confirms the
    // two controls above left the directory exactly as they found it.
    mkdirSync(runtimeRoot, { recursive: true });
    const entries = readdirSync(runtimeRoot)
      .filter((name) => name.endsWith(".ts"))
      .sort();
    expect(entries).toEqual([...EXPECTED_EXEMPTIONS].map((f) => f.split("/")[1]).sort());
  });
});
