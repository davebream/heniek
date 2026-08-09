/**
 * TypeScript views of the two published pipeline contracts.
 *
 * Every type here is derived from the TypeBox schema rather than written out
 * again, so the compiler enforces what the schema declares: a field added to
 * `PipelineGraph/v1` and forgotten in the normalizer is a type error, not a
 * silently missing key in the graph JSON.
 */

import type { PipelineDefinitionV1, PipelineGraphV1 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";

export type PipelineDocument = Static<typeof PipelineDefinitionV1>;
export type StageDocument = PipelineDocument["stages"][number];
export type EdgeDocument = NonNullable<PipelineDocument["edges"]>[number];
export type TransitionDocument = NonNullable<StageDocument["transitions"]>[number];
export type ConditionDocument = NonNullable<EdgeDocument["when"]>;
export type CompletionRequirementDocument = NonNullable<
  StageDocument["completion"]
>["require"][number];

export type PipelineGraph = Static<typeof PipelineGraphV1>;
export type PipelineStage = PipelineGraph["stages"][number];
export type PipelineEdge = PipelineGraph["edges"][number];
export type PipelineCondition = NonNullable<PipelineEdge["condition"]>;
export type ExpressionCondition = Extract<PipelineCondition, { kind: "expression" }>;
export type ExpressionNode = ExpressionCondition["nodes"][number];
export type CompletionRequirement = NonNullable<PipelineStage["completion"]>["require"][number];
export type PipelineStageId = PipelineStage["id"];
