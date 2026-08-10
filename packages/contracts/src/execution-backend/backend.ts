import type { Static } from "@sinclair/typebox";
import type { ArtifactId } from "../artifact/index.js";
import type { InteractionId } from "../interaction/index.js";
import type {
  BackendArtifactV1,
  BackendExecutionHandleV1,
  ExecutionEventV1,
  ExecutionEventV2,
  ExecutionEventV3,
  ExecutionRequestV1,
  ExecutionRequestV2,
  ExecutionRequestV3,
  ExecutionRequestV4,
  ExecutionRequestV5,
  ExecutionResultV1,
  ExecutionResultV2,
  ExecutionResultV3,
  ExecutionResultV4,
  ExecutionResultV5,
  ExecutionResumeRequestV1,
  ExecutionResumeRequestV2,
  InteractionAnswerSetV1,
  PendingInteractionV1,
  PendingInteractionV2,
} from "./schemas.js";
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

/**
 * Q012's durable adapter boundary. Handles and artifacts are opaque branded
 * IDs, and all provider payloads are translated before returning.
 */
export interface ExecutionBackendV2 {
  start(
    request: Static<typeof ExecutionRequestV2>,
  ): Promise<Static<typeof BackendExecutionHandleV1>>;
  status(executionId: string): Promise<ExecutionStatus>;
  interactions(executionId: string): Promise<Static<typeof PendingInteractionV2>[]>;
  answer(executionId: string, answer: Static<typeof InteractionAnswerSetV1>): Promise<void>;
  resume(executionId: string, inputArtifactRefs: ArtifactId[]): Promise<void>;
  result(executionId: string): Promise<Static<typeof ExecutionResultV2>>;
  cancel(executionId: string): Promise<void>;
  artifacts(executionId: string): Promise<Static<typeof BackendArtifactV1>[]>;
  readArtifact(executionId: string, artifactId: string): Promise<Uint8Array>;
}

/**
 * Q016's profile-aware execution boundary. V2 remains available unchanged
 * for the Q012 vertical slice; callers opt into V3 only after resolving a
 * named profile through the capability-gated configuration path.
 */
export interface ExecutionBackendV3 {
  start(
    request: Static<typeof ExecutionRequestV3>,
  ): Promise<Static<typeof BackendExecutionHandleV1>>;
  status(executionId: string): Promise<ExecutionStatus>;
  interactions(executionId: string): Promise<Static<typeof PendingInteractionV2>[]>;
  answer(executionId: string, answer: Static<typeof InteractionAnswerSetV1>): Promise<void>;
  resume(executionId: string, inputArtifactRefs: ArtifactId[]): Promise<void>;
  result(executionId: string): Promise<Static<typeof ExecutionResultV2>>;
  cancel(executionId: string): Promise<void>;
  artifacts(executionId: string): Promise<Static<typeof BackendArtifactV1>[]>;
  readArtifact(executionId: string, artifactId: string): Promise<Uint8Array>;
  events(executionId: string, after?: string): AsyncIterable<Static<typeof ExecutionEventV1>>;
}

/**
 * Q017's structured profile-aware execution boundary. V3 remains valid for
 * existing consumers while V4 carries the deliberately versioned event and
 * result contracts.
 */
export interface ExecutionBackendV4 {
  start(
    request: Static<typeof ExecutionRequestV3>,
  ): Promise<Static<typeof BackendExecutionHandleV1>>;
  status(executionId: string): Promise<ExecutionStatus>;
  interactions(executionId: string): Promise<Static<typeof PendingInteractionV2>[]>;
  answer(executionId: string, answer: Static<typeof InteractionAnswerSetV1>): Promise<void>;
  resume(executionId: string, inputArtifactRefs: ArtifactId[]): Promise<void>;
  result(executionId: string): Promise<Static<typeof ExecutionResultV3>>;
  cancel(executionId: string): Promise<void>;
  artifacts(executionId: string): Promise<Static<typeof BackendArtifactV1>[]>;
  readArtifact(executionId: string, artifactId: string): Promise<Uint8Array>;
  events(executionId: string, after?: string): AsyncIterable<Static<typeof ExecutionEventV2>>;
}

/**
 * Q019's truthful telemetry boundary. V4 remains byte-for-byte compatible;
 * V5 opts callers into explicit availability/confidence and live pressure.
 */
export interface ExecutionBackendV5 {
  start(
    request: Static<typeof ExecutionRequestV3>,
  ): Promise<Static<typeof BackendExecutionHandleV1>>;
  status(executionId: string): Promise<ExecutionStatus>;
  interactions(executionId: string): Promise<Static<typeof PendingInteractionV2>[]>;
  answer(executionId: string, answer: Static<typeof InteractionAnswerSetV1>): Promise<void>;
  resume(executionId: string, inputArtifactRefs: ArtifactId[]): Promise<void>;
  result(executionId: string): Promise<Static<typeof ExecutionResultV4>>;
  cancel(executionId: string): Promise<void>;
  artifacts(executionId: string): Promise<Static<typeof BackendArtifactV1>[]>;
  readArtifact(executionId: string, artifactId: string): Promise<Uint8Array>;
  events(executionId: string, after?: string): AsyncIterable<Static<typeof ExecutionEventV3>>;
}

/** Q020's recovery-safe backend boundary. V1-V5 remain frozen. */
export interface ExecutionBackendV6 {
  start(
    request: Static<typeof ExecutionRequestV3>,
  ): Promise<Static<typeof BackendExecutionHandleV1>>;
  status(executionId: string): Promise<ExecutionStatus>;
  interactions(executionId: string): Promise<Static<typeof PendingInteractionV2>[]>;
  answer(executionId: string, answer: Static<typeof InteractionAnswerSetV1>): Promise<void>;
  resume(request: Static<typeof ExecutionResumeRequestV1>): Promise<void>;
  result(executionId: string): Promise<Static<typeof ExecutionResultV4>>;
  cancel(executionId: string): Promise<void>;
  artifacts(executionId: string): Promise<Static<typeof BackendArtifactV1>[]>;
  readArtifact(executionId: string, artifactId: string): Promise<Uint8Array>;
  events(executionId: string, after?: string): AsyncIterable<Static<typeof ExecutionEventV3>>;
}

/** Q021's permission-bounded, failure-classified execution boundary. */
export interface ExecutionIdentifierReaderV1 {
  read(identifier: string): Promise<unknown>;
}

export interface ExecutionBackendV7 {
  start(
    request: Static<typeof ExecutionRequestV4>,
    context: { readonly identifierReader: ExecutionIdentifierReaderV1 },
  ): Promise<Static<typeof BackendExecutionHandleV1>>;
  status(executionId: string): Promise<ExecutionStatus>;
  interactions(executionId: string): Promise<Static<typeof PendingInteractionV2>[]>;
  answer(executionId: string, answer: Static<typeof InteractionAnswerSetV1>): Promise<void>;
  resume(request: Static<typeof ExecutionResumeRequestV1>): Promise<void>;
  result(executionId: string): Promise<Static<typeof ExecutionResultV5>>;
  cancel(executionId: string): Promise<void>;
  artifacts(executionId: string): Promise<Static<typeof BackendArtifactV1>[]>;
  readArtifact(executionId: string, artifactId: string): Promise<Uint8Array>;
  events(executionId: string, after?: string): AsyncIterable<Static<typeof ExecutionEventV3>>;
}

/**
 * Q029's segment-fusion backend boundary. V1–V7 remain frozen; V8 accepts
 * `ExecutionResumeRequest/v2` so fused successors and smart continuations can
 * carry a bounded next-stage instruction without leaking provider DTOs.
 */
export interface ExecutionBackendV8 {
  start(
    request: Static<typeof ExecutionRequestV4>,
    context: { readonly identifierReader: ExecutionIdentifierReaderV1 },
  ): Promise<Static<typeof BackendExecutionHandleV1>>;
  status(executionId: string): Promise<ExecutionStatus>;
  interactions(executionId: string): Promise<Static<typeof PendingInteractionV2>[]>;
  answer(executionId: string, answer: Static<typeof InteractionAnswerSetV1>): Promise<void>;
  resume(request: Static<typeof ExecutionResumeRequestV2>): Promise<void>;
  result(executionId: string): Promise<Static<typeof ExecutionResultV5>>;
  cancel(executionId: string): Promise<void>;
  artifacts(executionId: string): Promise<Static<typeof BackendArtifactV1>[]>;
  readArtifact(executionId: string, artifactId: string): Promise<Uint8Array>;
  events(executionId: string, after?: string): AsyncIterable<Static<typeof ExecutionEventV3>>;
}

/**
 * Capability-landing backend boundary. V1–V8 remain frozen; V9 accepts
 * `ExecutionRequest/v5` so a degradation delta can reach the executing stage.
 */
export interface ExecutionBackendV9 {
  start(
    request: Static<typeof ExecutionRequestV5>,
    context: { readonly identifierReader: ExecutionIdentifierReaderV1 },
  ): Promise<Static<typeof BackendExecutionHandleV1>>;
  status(executionId: string): Promise<ExecutionStatus>;
  interactions(executionId: string): Promise<Static<typeof PendingInteractionV2>[]>;
  answer(executionId: string, answer: Static<typeof InteractionAnswerSetV1>): Promise<void>;
  resume(request: Static<typeof ExecutionResumeRequestV2>): Promise<void>;
  result(executionId: string): Promise<Static<typeof ExecutionResultV5>>;
  cancel(executionId: string): Promise<void>;
  artifacts(executionId: string): Promise<Static<typeof BackendArtifactV1>[]>;
  readArtifact(executionId: string, artifactId: string): Promise<Uint8Array>;
  events(executionId: string, after?: string): AsyncIterable<Static<typeof ExecutionEventV3>>;
}
