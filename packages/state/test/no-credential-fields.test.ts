/**
 * Credential-field scan for `@heniek/state` (design D7, D15; plan Task 5.6,
 * round-1 finding M5 — this schedules the test `errors.ts`'s house rule
 * already stated but no task previously created).
 *
 * The sibling implementation is
 * `packages/contracts/test/no-credential-fields.test.ts`, which walks that
 * package's JSON-schema registry. **This package has no registry to walk**, so
 * the scan here is a text scan over `src/**\/*.ts` instead, in the same style
 * as `no-ambient-sources.test.ts`: collect every declared interface/type
 * property name and every `readonly`/`private` class field name, then assert
 * none of them looks like a credential.
 *
 * The rule this enforces is that no secret-shaped value may become a *stored*
 * or *reported* field of this package — journal payloads, projection rows,
 * error fields, and report objects all pass through these declarations.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = resolve(packageRoot, "src");

/** The same pattern `packages/contracts/test/no-credential-fields.test.ts` uses. */
const CREDENTIAL_NAME_PATTERN =
  /password|secret|token|api[-_]?key|credential|private[-_]?key|access[-_]?key|passphrase/i;

/** `foo:`, `readonly foo:`, `foo?:` — an interface/type member or a class field. */
const PROPERTY_DECLARATION =
  /^\s*(?:readonly\s+|private\s+|public\s+|protected\s+)*([A-Za-z_$][\w$]*)\s*[?:]/;

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => resolve(entry.parentPath, entry.name));
}

describe("no credential-shaped field names under src/ (D7, D15, M5)", () => {
  it("every declared property and class field name is free of credential vocabulary", async () => {
    const files = await listTypeScriptFiles(srcRoot);
    const propertyNames: string[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const line of content.split("\n")) {
        const match = PROPERTY_DECLARATION.exec(line);
        if (match?.[1] !== undefined) {
          propertyNames.push(match[1]);
        }
      }
    }

    const offenders = propertyNames.filter((name) => CREDENTIAL_NAME_PATTERN.test(name));
    expect(offenders).toEqual([]);

    // Non-vacuity, mirroring Task 5.5's file-count bound but counted over
    // property names: a wrong `srcRoot` or a regex that matches nothing
    // cannot silently report zero offenders and pass.
    expect(propertyNames.length).toBeGreaterThanOrEqual(20);
  });

  it("the pattern and the declaration regex both actually match (negative control)", () => {
    expect(CREDENTIAL_NAME_PATTERN.test("apiKey")).toBe(true);
    expect(CREDENTIAL_NAME_PATTERN.test("access_key")).toBe(true);
    expect(CREDENTIAL_NAME_PATTERN.test("refreshToken")).toBe(true);
    expect(CREDENTIAL_NAME_PATTERN.test("lastEventSequence")).toBe(false);

    expect(PROPERTY_DECLARATION.exec("  readonly correlationId: CorrelationId;")?.[1]).toBe(
      "correlationId",
    );
    expect(PROPERTY_DECLARATION.exec("  runId?: string;")?.[1]).toBe("runId");
  });
});
