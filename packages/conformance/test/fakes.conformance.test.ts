import { describe, expect, it } from "vitest";
import {
  EXECUTION_BACKEND_CASES,
  FORGE_BACKEND_CASES,
  PIPELINE_RUNTIME_CASES,
  TASK_SOURCE_CASES,
} from "../src/cases/catalogue.js";
import type { ConformanceCapability } from "../src/contract/capability.js";
import { missingCapabilities } from "../src/contract/capability.js";
import {
  createFakeExecutionBackendHarness,
  createFakeForgeBackendHarness,
  createFakePipelineRuntimeHarness,
  createFakeTaskSourceHarness,
} from "../src/fakes/index.js";
import {
  describeExecutionBackendConformance,
  describeForgeBackendConformance,
  describePipelineRuntimeConformance,
  describeTaskSourceConformance,
} from "../src/runner/vitest.js";

function unionOfRequires(
  cases: readonly { readonly requires: readonly ConformanceCapability[] }[],
): ConformanceCapability[] {
  const union = new Set<ConformanceCapability>();
  for (const testCase of cases) {
    for (const capability of testCase.requires) {
      union.add(capability);
    }
  }
  return [...union];
}

describe("every fake declares every capability its own catalogue requires (RT2)", () => {
  it("fake-execution-backend has no missing capability", () => {
    const harness = createFakeExecutionBackendHarness();
    expect(
      missingCapabilities(harness.capabilities, unionOfRequires(EXECUTION_BACKEND_CASES)),
    ).toEqual([]);
  });

  it("fake-task-source has no missing capability", () => {
    const harness = createFakeTaskSourceHarness();
    expect(missingCapabilities(harness.capabilities, unionOfRequires(TASK_SOURCE_CASES))).toEqual(
      [],
    );
  });

  it("fake-forge-backend has no missing capability", () => {
    const harness = createFakeForgeBackendHarness();
    expect(missingCapabilities(harness.capabilities, unionOfRequires(FORGE_BACKEND_CASES))).toEqual(
      [],
    );
  });

  it("fake-pipeline-runtime has no missing capability", () => {
    const harness = createFakePipelineRuntimeHarness();
    expect(
      missingCapabilities(harness.capabilities, unionOfRequires(PIPELINE_RUNTIME_CASES)),
    ).toEqual([]);
  });
});

// Every case below must run — none skipped — because each fake declares
// every capability its family's catalogue requires.
describeExecutionBackendConformance(createFakeExecutionBackendHarness());
describeTaskSourceConformance(createFakeTaskSourceHarness());
describeForgeBackendConformance(createFakeForgeBackendHarness());
describePipelineRuntimeConformance(createFakePipelineRuntimeHarness());
