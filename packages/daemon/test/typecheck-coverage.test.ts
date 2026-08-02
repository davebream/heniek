/**
 * C18: proves `packages/daemon` is typechecked by root `tsc --noEmit` with
 * **no root `tsconfig.json` edit** (design Alternative H). `include` already
 * covers `packages/*\/{src,test,scripts}/**\/*.ts` (`tsconfig.json:23-28`),
 * so placing `@heniek/daemon` under `packages/*` buys coverage for free —
 * this test is the *permanent guard* against a future `include` edit
 * silently un-typechecking the package, not the proof of coverage itself
 * (the direct proof is the deliberate-type-error probe captured in the
 * Phase 7 evidence sidecar, per plan Task 1 Step 4).
 *
 * `globSync` is matched against **concrete file paths**, never
 * glob-against-glob (plan-review round 1, finding M3: a glob matched
 * against another glob is not a defined operation, and no glob-matcher
 * package is in the catalog). Both concrete paths are asserted to exist
 * first, so this test cannot pass by matching nothing.
 */

import { existsSync, globSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");

interface TsconfigShape {
  readonly include: readonly string[];
}

async function readInclude(): Promise<readonly string[]> {
  const raw = await readFile(resolve(repoRoot, "tsconfig.json"), "utf8");
  const config = JSON.parse(raw) as TsconfigShape;
  return config.include;
}

function matchedFiles(include: readonly string[]): Set<string> {
  const matched = new Set<string>();
  for (const pattern of include) {
    for (const file of globSync(pattern, { cwd: repoRoot })) {
      matched.add(resolve(repoRoot, file));
    }
  }
  return matched;
}

describe("packages/daemon is provably covered by root tsc --noEmit (C18)", () => {
  it("root tsconfig.json's include array matches this package's src and test files", async () => {
    const indexPath = resolve(repoRoot, "packages/daemon/src/index.ts");
    const selfPath = resolve(repoRoot, "packages/daemon/test/typecheck-coverage.test.ts");

    // Non-vacuity: assert both files exist before checking membership, so
    // this test cannot pass by matching nothing.
    expect(existsSync(indexPath)).toBe(true);
    expect(existsSync(selfPath)).toBe(true);

    const include = await readInclude();
    const matched = matchedFiles(include);

    expect(matched.has(indexPath)).toBe(true);
    expect(matched.has(selfPath)).toBe(true);
  });

  it("if an apps/ unit exists, its src/**/*.ts files are also covered by include", async () => {
    const appsRoot = resolve(repoRoot, "apps");

    // Inert today — no `apps/` directory exists at 61325e8 (verified). This
    // branch fires the day someone adds the first `apps/*` unit without
    // extending `include` (design Alternative I, rejected but guarded).
    if (!existsSync(appsRoot)) {
      return;
    }

    const include = await readInclude();
    const matched = matchedFiles(include);

    const appEntries = await readdir(appsRoot, { withFileTypes: true });
    for (const entry of appEntries) {
      if (!entry.isDirectory()) continue;
      const appSrcRoot = resolve(appsRoot, entry.name, "src");
      if (!existsSync(appSrcRoot)) continue;

      const covered = [...matched].some(
        (file) => file.startsWith(`${appSrcRoot}/`) && file.endsWith(".ts"),
      );
      expect(covered, `apps/${entry.name}/src has no .ts file covered by tsconfig include`).toBe(
        true,
      );
    }
  });
});
