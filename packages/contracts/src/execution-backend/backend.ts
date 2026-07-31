import type { Static } from "@sinclair/typebox";
import type { ArtifactId } from "../artifact/index.js";
import type { InteractionId } from "../interaction/index.js";
import type { ExecutionRequestV1, ExecutionResultV1, PendingInteractionV1 } from "./schemas.js";
import type { ExecutionStatus } from "./state.js";

/**
 * §22, verbatim signatures with IDs branded — except `runId`, which stays
 * `string`: the spec text immediately below this interface says "The
 * pipeline runtime stores its own IDs and maps them to backend run IDs",
 * i.e. this `runId` is a *different*, backend-native identifier space from
 * this package's own `RunId` (`run/ids.ts`). Branding it `RunId` would
 * conflate the two namespaces the spec explicitly keeps apart.
 */
export interface ExecutionBackend {
  start(request: Static<typeof ExecutionRequestV1>): Promise<string>;
  status(runId: string): Promise<ExecutionStatus>;
  interactions(runId: string): Promise<Static<typeof PendingInteractionV1>[]>;
  answer(runId: string, interactionId: InteractionId, answer: unknown): Promise<void>;
  resume(runId: string, inputArtifactRefs: ArtifactId[]): Promise<void>;
  result(runId: string): Promise<Static<typeof ExecutionResultV1>>;
  cancel(runId: string): Promise<void>;
}
