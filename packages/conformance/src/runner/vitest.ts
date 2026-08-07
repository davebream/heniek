import type { ExecutionBackend, ForgeBackend, TaskSource } from "@heniek/contracts";
import { describe, it } from "vitest";
import {
  EXECUTION_BACKEND_CASES,
  FORGE_BACKEND_CASES,
  TASK_SOURCE_CASES,
} from "../cases/catalogue.js";
import type {
  ExecutionArrangement,
  ForgeArrangement,
  TaskSourceArrangement,
} from "../contract/arrangement.js";
import { missingCapabilities } from "../contract/capability.js";
import type { ConformanceCase } from "../contract/case.js";
import type { ConformanceHarness } from "../contract/harness.js";
import { DEFAULT_SEED, type Seed } from "../kernel/seed.js";
import { runConformanceCase } from "./case-context.js";

export interface DescribeConformanceOptions {
  readonly seed?: Seed;
  readonly titlePrefix?: string;
}

function describeFamily<TSubject, TArrangement>(
  familyLabel: string,
  cases: readonly ConformanceCase<TSubject, TArrangement>[],
  harness: ConformanceHarness<TSubject, TArrangement>,
  options: DescribeConformanceOptions | undefined,
): void {
  const seedValue = options?.seed ?? DEFAULT_SEED;
  const prefix = options?.titlePrefix === undefined ? "" : `${options.titlePrefix} `;

  describe(`${prefix}${harness.name} · ${familyLabel}`, () => {
    for (const testCase of cases) {
      const missing = missingCapabilities(harness.capabilities, testCase.requires);
      if (missing.length > 0) {
        it.skip(`${testCase.title} [unsupported: ${missing.join(", ")}]`, () => {
          // Intentionally empty: the skip title itself names the missing
          // capability, so a skip is always attributable, never silent.
        });
        continue;
      }
      it(testCase.title, async () => {
        await runConformanceCase(harness, testCase, seedValue);
      });
    }
  });
}

export function describeExecutionBackendConformance(
  harness: ConformanceHarness<ExecutionBackend, ExecutionArrangement>,
  options?: DescribeConformanceOptions,
): void {
  describeFamily("ExecutionBackend", EXECUTION_BACKEND_CASES, harness, options);
}

export function describeTaskSourceConformance(
  harness: ConformanceHarness<TaskSource, TaskSourceArrangement>,
  options?: DescribeConformanceOptions,
): void {
  describeFamily("TaskSource", TASK_SOURCE_CASES, harness, options);
}

export function describeForgeBackendConformance(
  harness: ConformanceHarness<ForgeBackend, ForgeArrangement>,
  options?: DescribeConformanceOptions,
): void {
  describeFamily("ForgeBackend", FORGE_BACKEND_CASES, harness, options);
}
