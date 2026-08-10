import assert from "node:assert/strict";
import {
  PipelineAppliedOverrideV1,
  PipelineAttachmentLifecycleV1,
  type PipelineAttachRequestV1,
  type PipelineAttachResultV1 as PipelineAttachResult,
  PipelineAttachResultV1,
  PipelineDefinitionSourceV1,
  PipelineGraphV1,
  type PipelineValidateRequestV1,
  type PipelineValidateResultV1 as PipelineValidateResult,
  PipelineValidateResultV1,
} from "@heniek/contracts";
import type { ConformanceCase } from "../contract/case.js";
import type { PipelineRuntimeArrangement } from "../contract/pipeline-runtime.js";
import { assertValid } from "../contract/validation.js";

/**
 * Minimal surface the PipelineRuntime conformance family drives (Q032).
 * Real daemon wiring implements the same contracts via RPC; the fake
 * exercises admission + attachment policy without a live daemon.
 */
export interface PipelineRuntime {
  validate(request: PipelineValidateRequestV1): Promise<PipelineValidateResult>;
  attach(request: PipelineAttachRequestV1): Promise<PipelineAttachResult>;
}

type PipelineRuntimeCase = ConformanceCase<PipelineRuntime, PipelineRuntimeArrangement>;

const MINIMAL_YAML = `schemaVersion: 1
id: minimal
stages:
  - id: only
    type: approval
`;

const VALIDATE_RESULT_REFS = [
  PipelineDefinitionSourceV1,
  PipelineGraphV1,
  PipelineAppliedOverrideV1,
] as const;

const ATTACH_RESULT_REFS = [PipelineAttachmentLifecycleV1] as const;

export const PIPELINE_RUNTIME_CASES: readonly PipelineRuntimeCase[] = [
  {
    id: "pipeline/admission-named-and-one-off-both-accept",
    title: "named bundled and equivalent one-off YAML both admit cleanly",
    requires: ["pipeline-admission"],
    covers: ["AC1:lifecycle", "Q032:admission-parity"],
    async run({ subject, arrange }) {
      await arrange({ kind: "clean" });
      const named = await subject.validate({
        schemaVersion: 1,
        source: { kind: "named", pipelineId: "fast" as never },
      });
      assertValid(
        PipelineValidateResultV1,
        named,
        "PipelineValidateResultV1",
        VALIDATE_RESULT_REFS,
      );
      assert.equal(named.accepted, true);

      const oneOff = await subject.validate({
        schemaVersion: 1,
        source: { kind: "one-off", definitionText: MINIMAL_YAML, format: "yaml" },
      });
      assertValid(
        PipelineValidateResultV1,
        oneOff,
        "PipelineValidateResultV1",
        VALIDATE_RESULT_REFS,
      );
      assert.equal(oneOff.accepted, true);
      assert.match(oneOff.pipelineId ?? "", /^oneoff\.[0-9a-f]{64}$/);
    },
  },
  {
    id: "pipeline/attachment-rejects-when-target-not-quiescent",
    title: "attachment rejects a non-quiescent target run",
    requires: ["pipeline-attachment"],
    covers: ["AC1:lifecycle", "Q032:attachment-quiescence"],
    async run({ subject, arrange }) {
      await arrange({ kind: "non-quiescent-target" });
      const result = await subject.attach({
        schemaVersion: 1,
        attachmentId: "attach-conformance-1",
        sourceRunId: "run-source" as never,
        sourceStageId: "fix" as never,
        targetRunId: "run-target" as never,
        stage: {
          schemaVersion: 1,
          id: "adhoc-fix" as never,
          type: "agent",
          profile: "fixer",
        },
        dependantStageIds: ["build" as never],
        expectedRunRevision: 1,
        expectedGraphRevision: 1,
        expectedScheduleRevision: 1,
      });
      assertValid(PipelineAttachResultV1, result, "PipelineAttachResultV1", ATTACH_RESULT_REFS);
      assert.equal(result.accepted, false);
      assert.equal(result.rejectionCode, "not-quiescent");
    },
  },
];
