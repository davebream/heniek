import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_CONFORMANCE_CASE_IDS, REQUIRED_COVERAGE } from "../src/cases/catalogue.js";
import {
  buildConformanceMatrix,
  renderConformanceMatrixMarkdown,
  SUBJECT_DECLARATIONS,
} from "../src/matrix.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A committed, literal snapshot of every catalogue case id (MAJOR-3). This
 * is deliberately NOT derived from the catalogue itself — it is hand-pinned
 * here, mirroring `test/contracts-compatibility.test.ts`'s
 * `EXPECTED_SCHEMAS` pattern. Without an independent pin, every anti-drift
 * check above is one-directional: it can catch the matrix disagreeing with
 * the catalogue, but nothing catches the catalogue itself silently
 * shrinking (e.g. deleting both cancellation cases plus the
 * `"cancellation"` capability from every declaring subject leaves every
 * check above green). Deleting or renaming a case must fail *this* test;
 * intentionally adding, removing, or renaming a case means updating this
 * literal list by hand in the same change.
 */
const EXPECTED_CASE_IDS: readonly string[] = [
  "execution/answer-is-rejected-after-terminal",
  "execution/answer-rejects-unknown-interaction-id",
  "execution/answer-resolves-the-pending-interaction",
  "execution/cancel-is-idempotent",
  "execution/cancel-transitions-to-cancelled-and-result-agrees",
  "execution/crash-requires-explicit-recovery-then-resumes",
  "execution/disconnect-is-classified-and-retryable",
  "execution/interaction-is-surfaced-as-contract-valid-pending-interaction",
  "execution/interaction-moves-status-to-waiting-on-user",
  "execution/interactions-are-empty-when-not-waiting",
  "execution/malformed-result-is-rejected-not-returned",
  "execution/rate-limit-is-classified-and-retryable",
  "execution/result-is-rejected-before-terminal",
  "execution/result-matches-execution-result-contract",
  "execution/resume-continues-and-records-input-artifacts",
  "execution/resume-rejects-unknown-run-id",
  "execution/start-rejects-contract-invalid-request",
  "execution/start-returns-opaque-run-id",
  "execution/start-yields-distinct-run-ids",
  "execution/status-is-non-terminal-immediately-after-start",
  "execution/status-is-stable-once-terminal",
  "execution/status-reaches-declared-terminal-state",
  "execution/status-rejects-unknown-run-id",
  "forge/create-pull-request-honours-draft-true",
  "forge/create-pull-request-returns-contract-valid-pull-request",
  "forge/disconnect-is-classified-and-retryable",
  "forge/enable-auto-merge-on-draft-pr-is-a-conflict",
  "forge/enable-auto-merge-with-stale-head-is-a-conflict",
  "forge/get-checks-returns-contract-valid-check-statuses",
  "forge/get-failed-check-logs-returns-only-failed-checks",
  "forge/mark-ready-clears-draft",
  "forge/mark-ready-is-idempotent",
  "forge/mark-ready-rejects-unknown-pull-request-id",
  "forge/rate-limit-is-classified",
  "task-source/load-classifies-conflict-fault-for-stale-revision",
  "task-source/load-classifies-rate-limit-fault",
  "task-source/load-increments-revision-after-re-snapshot",
  "task-source/load-is-deterministic-for-repeated-load-of-same-input",
  "task-source/load-rejects-malformed-input",
  "task-source/load-rejects-unknown-source-kind",
  "task-source/load-returns-contract-valid-task-context",
];

describe("conformance matrix anti-drift (RE1)", () => {
  it("the committed conformance-matrix.json is current", async () => {
    const committed = JSON.parse(
      await readFile(resolve(packageRoot, "generated/conformance-matrix.json"), "utf8"),
    );
    expect(buildConformanceMatrix()).toEqual(committed);
  });

  it("the committed conformance-matrix.md is current", async () => {
    const committed = await readFile(
      resolve(packageRoot, "generated/conformance-matrix.md"),
      "utf8",
    );
    expect(renderConformanceMatrixMarkdown(buildConformanceMatrix())).toEqual(committed);
  });

  it("every catalogue case is covered by at least one subject", () => {
    const matrix = buildConformanceMatrix();
    matrix.cases.forEach((testCase, index) => {
      const row = matrix.cells[index] ?? [];
      expect(
        row.some((cell) => cell === "covered"),
        `no subject covers ${testCase.caseId}`,
      ).toBe(true);
    });
  });

  it("every declared subject capability is required by at least one case of its own family", () => {
    const matrix = buildConformanceMatrix();
    for (const subject of SUBJECT_DECLARATIONS) {
      const requiredByFamily = new Set(
        matrix.cases
          .filter((testCase) => testCase.family === subject.family)
          .flatMap((testCase) => testCase.requires),
      );
      for (const capability of subject.capabilities) {
        expect(
          requiredByFamily.has(capability),
          `subject "${subject.id}" declares "${capability}", which no ${subject.family} case requires`,
        ).toBe(true);
      }
    }
  });

  it("catalogue case ids are unique and in strict codepoint order", () => {
    // The original version of this assertion re-sorted
    // `ALL_CONFORMANCE_CASE_IDS` with the exact comparator that produced it
    // and compared the result to itself — a tautology that cannot fail
    // under any comparator, locale, or catalogue content. This version
    // walks the array pairwise with plain `<`, which fails the moment two
    // adjacent entries are not in strict ascending codepoint order,
    // independent of whatever comparator (if any) built the array.
    for (let index = 1; index < ALL_CONFORMANCE_CASE_IDS.length; index += 1) {
      const previous = ALL_CONFORMANCE_CASE_IDS[index - 1];
      const current = ALL_CONFORMANCE_CASE_IDS[index];
      expect(
        previous !== undefined && current !== undefined && previous < current,
        `case ids out of strict codepoint order at index ${index}: "${previous}" >= "${current}"`,
      ).toBe(true);
    }
    expect(new Set(ALL_CONFORMANCE_CASE_IDS).size).toBe(ALL_CONFORMANCE_CASE_IDS.length);
  });

  it("ALL_CONFORMANCE_CASE_IDS matches the committed snapshot pin (MAJOR-3)", () => {
    // Independent of everything derived from the catalogue: this is the
    // check that actually fails when a case is deleted, renamed, or added
    // without a matching update to `EXPECTED_CASE_IDS` above.
    expect(ALL_CONFORMANCE_CASE_IDS).toEqual(EXPECTED_CASE_IDS);
  });

  it("every REQUIRED_COVERAGE axis is covered by at least one case", () => {
    // The companion, orthogonal anti-drift gate to the snapshot pin above:
    // even if the case *count* never shrinks, a case could still be
    // rewritten to no longer exercise a given AC1/AC2 axis. This fails the
    // moment no surviving case's `covers` array contains a given axis tag.
    const matrix = buildConformanceMatrix();
    const coveredAxes = new Set(matrix.cases.flatMap((testCase) => testCase.covers));
    for (const axis of REQUIRED_COVERAGE) {
      expect(coveredAxes.has(axis), `no case covers required axis "${axis}"`).toBe(true);
    }
  });
});
