import { EXECUTION_BACKEND_CASES } from "./execution-backend.js";
import { FORGE_BACKEND_CASES } from "./forge-backend.js";
import { TASK_SOURCE_CASES } from "./task-source.js";

export { EXECUTION_BACKEND_CASES } from "./execution-backend.js";
export { FORGE_BACKEND_CASES } from "./forge-backend.js";
export { TASK_SOURCE_CASES } from "./task-source.js";

interface CaseLike {
  readonly id: string;
  readonly requires: readonly string[];
  readonly covers: readonly string[];
}

function assertUniqueIds(cases: readonly CaseLike[]): void {
  const seen = new Set<string>();
  for (const testCase of cases) {
    if (seen.has(testCase.id)) {
      throw new Error(`Duplicate conformance case id: ${testCase.id}`);
    }
    seen.add(testCase.id);
  }
}

const ALL_CASES: readonly CaseLike[] = [
  ...EXECUTION_BACKEND_CASES,
  ...TASK_SOURCE_CASES,
  ...FORGE_BACKEND_CASES,
];

// Asserted at module load — mirrors `versioned()`'s duplicate guard in
// `@heniek/contracts`, so a copy-pasted case id fails immediately on import
// rather than silently shadowing coverage.
assertUniqueIds(ALL_CASES);

/**
 * Codepoint comparator — deliberately not `localeCompare`, whose collation
 * order depends on the ICU default locale (e.g. `cs`/`da`/`sk` treat `ch` as
 * a digraph and reorder ASCII case ids), which would make every artifact
 * derived from this ordering (the generated matrix, `ALL_CONFORMANCE_CASE_IDS`
 * itself) non-reproducible across contributor machines and locales.
 */
function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every catalogue case id, flat and sorted — the stable enumeration the matrix generator walks. */
export const ALL_CONFORMANCE_CASE_IDS: readonly string[] = ALL_CASES.map((testCase) => testCase.id)
  .slice()
  .sort(byCodepoint);

export interface ConformanceCoverageEntry {
  readonly caseId: string;
  readonly requires: readonly string[];
  readonly covers: readonly string[];
}

/** Every catalogue case's id, required capabilities, and covered anchors — used by the matrix generator. */
export function describeCoverage(): readonly ConformanceCoverageEntry[] {
  return ALL_CASES.map((testCase) => ({
    caseId: testCase.id,
    requires: testCase.requires,
    covers: testCase.covers,
  })).sort((a, b) => byCodepoint(a.caseId, b.caseId));
}

/**
 * The machine-checkable axis vocabulary `covers` entries must draw from for
 * AC1/AC2 coverage (design/MAJOR-3, NEW coverage anti-drift gate). Before
 * this list existed, every case's `covers` array used the single coarse tag
 * `"AC1"` or `"AC2"` for every sub-behaviour, so deleting, say, both
 * cancellation cases (and the `"cancellation"` capability from every
 * declaring subject) left every existing check green — nothing distinguished
 * "AC1 lifecycle is covered" from "AC1's cancellation axis specifically is
 * covered". `test/matrix.test.ts` asserts every entry below appears in at
 * least one case's `covers` array, so dropping an axis (by deleting the case
 * that covers it, or by no longer tagging any surviving case with it) fails
 * a check instead of passing silently.
 *
 * `"AC1:lifecycle"` is the generic AC1 tag for TaskSource/ForgeBackend cases
 * that exercise basic contract-valid-output/idempotency behaviour — AC1's
 * text enumerates verbs specific to the `ExecutionBackend` lifecycle
 * (start/status/interaction/answer/resume/result/cancellation/malformed),
 * which the other two families do not have a 1:1 mapping onto.
 */
export const REQUIRED_COVERAGE = [
  "AC1:start",
  "AC1:status",
  "AC1:interaction",
  "AC1:answer",
  "AC1:resume",
  "AC1:result",
  "AC1:cancellation",
  "AC1:malformed",
  "AC1:lifecycle",
  "AC2:disconnect",
  "AC2:rate-limit",
  "AC2:stale-ref",
  "AC2:conflict",
  "AC2:crash-recovery",
] as const;
export type RequiredCoverageAxis = (typeof REQUIRED_COVERAGE)[number];
