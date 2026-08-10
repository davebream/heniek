import { createHash } from "node:crypto";
import type {
  PipelineAttachRequestV1,
  PipelineAttachResultV1,
  PipelineValidateRequestV1,
  PipelineValidateResultV1,
} from "@heniek/contracts";
import type { PipelineRuntime } from "../cases/pipeline-runtime.js";
import type { ConformanceCapability } from "../contract/capability.js";
import type { ConformanceHarness } from "../contract/harness.js";
import type { PipelineRuntimeArrangement } from "../contract/pipeline-runtime.js";
import type { ConformanceContext } from "../kernel/context.js";

export const FAKE_PIPELINE_RUNTIME_CAPABILITIES: readonly ConformanceCapability[] = [
  "pipeline-admission",
  "pipeline-attachment",
];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface FakePipelineRuntime {
  readonly runtime: PipelineRuntime;
  arrange(arrangement: PipelineRuntimeArrangement): void;
}

/**
 * In-memory PipelineRuntime subject. Admission parity is simulated with the
 * same one-off id rule (`oneoff.<sha256>`) the real door uses; attachment
 * quiescence is arranged explicitly for the catalogue case.
 */
export function createFakePipelineRuntime(_context: ConformanceContext): FakePipelineRuntime {
  let arrangement: PipelineRuntimeArrangement = { kind: "clean" };

  const runtime: PipelineRuntime = {
    async validate(request: PipelineValidateRequestV1): Promise<PipelineValidateResultV1> {
      if (request.source.kind === "named") {
        if (request.source.pipelineId === "fast" || request.source.pipelineId === "careful") {
          const digest = sha256(`bundled:${request.source.pipelineId}.v1`);
          return {
            schemaVersion: 1,
            accepted: true,
            pipelineId: request.source.pipelineId,
            source: {
              schemaVersion: 1,
              kind: "bundled",
              identity: `${request.source.pipelineId}.v1`,
              digest,
            },
            appliedOverrides: [],
            diagnostics: [],
          };
        }
        return {
          schemaVersion: 1,
          accepted: false,
          appliedOverrides: [],
          diagnostics: [
            {
              code: "pipeline.admission.unknown-named",
              severity: "error",
              message: `No named pipeline definition found for ${request.source.pipelineId}.`,
            },
          ],
        };
      }
      const contentDigest = sha256(request.source.definitionText);
      const pipelineId = `oneoff.${contentDigest}`;
      return {
        schemaVersion: 1,
        accepted: true,
        pipelineId: pipelineId as never,
        source: {
          schemaVersion: 1,
          kind: "one-off",
          identity: pipelineId,
          digest: contentDigest,
        },
        appliedOverrides: [],
        diagnostics: [],
      };
    },
    async attach(request: PipelineAttachRequestV1): Promise<PipelineAttachResultV1> {
      if (arrangement.kind === "non-quiescent-target") {
        return {
          schemaVersion: 1,
          accepted: false,
          idempotentReplay: false,
          rejectionCode: "not-quiescent",
          diagnostics: [
            {
              code: "pipeline.attach.not-quiescent",
              severity: "error",
              message: "Target run has active stages; attachment requires quiescence.",
            },
          ],
        };
      }
      return {
        schemaVersion: 1,
        accepted: false,
        idempotentReplay: false,
        rejectionCode: "target-missing",
        diagnostics: [
          {
            code: "pipeline.attach.target-missing",
            severity: "error",
            message: `No in-memory target for ${request.targetRunId}.`,
          },
        ],
      };
    },
  };

  return {
    runtime,
    arrange(next) {
      arrangement = next;
    },
  };
}

export function createFakePipelineRuntimeHarness(): ConformanceHarness<
  PipelineRuntime,
  PipelineRuntimeArrangement
> {
  return {
    name: "fake-pipeline-runtime",
    capabilities: FAKE_PIPELINE_RUNTIME_CAPABILITIES,
    classifyFault() {
      return "unknown";
    },
    async createSubject(context) {
      const fake = createFakePipelineRuntime(context);
      return {
        subject: fake.runtime,
        async arrange(arrangement) {
          fake.arrange(arrangement);
        },
        async dispose() {},
      };
    },
  };
}
