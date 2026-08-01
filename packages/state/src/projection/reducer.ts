/**
 * The pure reducer (design D11; plan Task 4.2 and P3).
 *
 * No I/O, no clock, no randomness, no `DatabaseSync` anywhere in the
 * signature. This is the same function `commitStateChange` folds forward and
 * Phase 5's `replayJournal` re-folds from scratch — deliberately *one*
 * function rather than two parallel code paths, because AC3's whole claim is
 * that re-running the journal reproduces the stored projection exactly.
 *
 * Every rule sets `lastEventSequence = event.sequence` and
 * `updatedAt = event.recordedAt`, which is what makes the projection a
 * strictly monotonic function of the journal and makes replay comparison
 * exact under any clock, advancing or not.
 *
 * **Standing obligation (design open item 4):** every future issue that adds
 * an event type or a projection table must extend **both** `applyEvent`/
 * `eventScope` here **and** Phase 5's `compareProjectionToReplay`. Extending
 * only one silently narrows the divergence checker over time. ADR 0005 states
 * this explicitly.
 */

import { RunStatus } from "@heniek/contracts";
import { ReducerError } from "../errors.js";
import type { StateEvent } from "../journal/event.js";
import type { JsonValue } from "../json.js";
import type { ProjectionScope, ProjectionState } from "./state.js";
import { stageArtifactAliasKey } from "./state.js";

export type Reducer = (state: ProjectionState, event: StateEvent) => ProjectionState;

/** The six-member vocabulary (P3) — the minimum that exercises the run projection, the identity rows, and a relationship. */
const RUN_SCOPED_TYPES = new Set(["run.created", "run.status_changed", "run.workspace_assigned"]);

/**
 * Q007's two new event types (design D4, D11; plan Task 2.2). Both are
 * stage-scoped — `run_id` is required, exactly like the `run.*` types —
 * but neither starts with the `run.` prefix `RUN_SCOPED_TYPES` matches, so
 * they get their own set rather than being folded into it.
 */
const STAGE_SCOPED_TYPES = new Set(["artifact.published", "stage.completed"]);

/** One artifact ref, as carried inside an `artifact.published` or `stage.completed` payload. */
interface ArtifactRefPayload {
  readonly artifactId: string;
  readonly name: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly contentSchemaId: string;
  readonly producer: string;
  readonly sourceLineage: readonly string[];
  readonly relativePath: string;
}

/**
 * An explicit predicate rather than an inline `Array.isArray` check: lib.dom's
 * `Array.isArray` is declared `(arg: any) => arg is any[]`, which does not
 * narrow a `readonly JsonValue[]` out of the union, so the inline form leaves
 * the array branch in the return type and would need an `as` to compile. The
 * predicate states the intended narrowing once, in the same style as
 * `isRunStatus` below and `projection/run.ts`'s.
 */
function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function payloadObject(event: StateEvent): Readonly<Record<string, JsonValue>> {
  const { payload } = event;
  if (!isJsonObject(payload)) {
    throw new ReducerError(event.eventId, event.type, "payload must be a JSON object");
  }
  return payload;
}

function requireString(
  event: StateEvent,
  payload: Readonly<Record<string, JsonValue>>,
  field: string,
): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ReducerError(
      event.eventId,
      event.type,
      `payload.${field} must be a non-empty string`,
    );
  }
  return value;
}

function optionalWorkspaceId(
  event: StateEvent,
  payload: Readonly<Record<string, JsonValue>>,
): string | null {
  const value = payload.workspaceId;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ReducerError(
      event.eventId,
      event.type,
      "payload.workspaceId must be a non-empty string, null, or omitted",
    );
  }
  return value;
}

/**
 * `payload.runId` must equal `event.runId` — but **only for `run.*` types**
 * (finding C5). The three identity types carry no `runId` in their payload at
 * all and have `event.runId === null` by construction, so there is simply
 * nothing to compare; an earlier draft stated this rule as if it applied to
 * all six types, which contradicts the payload shapes.
 */
function requireRunId(event: StateEvent, payload: Readonly<Record<string, JsonValue>>): string {
  const runId = requireString(event, payload, "runId");
  if (event.runId !== runId) {
    throw new ReducerError(
      event.eventId,
      event.type,
      "payload.runId does not match the event's run_id",
    );
  }
  return runId;
}

function isRunStatus(candidate: string): candidate is RunStatus {
  return (RunStatus.values as readonly string[]).includes(candidate);
}

function requireNonNegativeInteger(
  event: StateEvent,
  payload: Readonly<Record<string, JsonValue>>,
  field: string,
): number {
  const value = payload[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ReducerError(
      event.eventId,
      event.type,
      `payload.${field} must be a non-negative integer`,
    );
  }
  return value;
}

function requireStringArray(
  event: StateEvent,
  payload: Readonly<Record<string, JsonValue>>,
  field: string,
): readonly string[] {
  const value = payload[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ReducerError(
      event.eventId,
      event.type,
      `payload.${field} must be an array of strings`,
    );
  }
  return value;
}

/**
 * Narrows one entry of `payload.artifacts` (`stage.completed`) or the
 * top-level payload (`artifact.published`) into an `ArtifactRefPayload`.
 * Deliberately re-validates every field with the same `require*` helpers the
 * top-level payload cases use, rather than trusting `isJsonObject` alone —
 * an array element is JSON but not necessarily this shape.
 */
function toArtifactRefPayload(
  event: StateEvent,
  value: JsonValue,
  index: number,
): ArtifactRefPayload {
  if (!isJsonObject(value)) {
    throw new ReducerError(
      event.eventId,
      event.type,
      `payload.artifacts[${index}] must be a JSON object`,
    );
  }
  return {
    artifactId: requireString(event, value, "artifactId"),
    name: requireString(event, value, "name"),
    contentHash: requireString(event, value, "contentHash"),
    byteLength: requireNonNegativeInteger(event, value, "byteLength"),
    mediaType: requireString(event, value, "mediaType"),
    contentSchemaId: requireString(event, value, "contentSchemaId"),
    producer: requireString(event, value, "producer"),
    sourceLineage: requireStringArray(event, value, "sourceLineage"),
    relativePath: requireString(event, value, "relativePath"),
  };
}

function requireArtifactRefs(
  event: StateEvent,
  payload: Readonly<Record<string, JsonValue>>,
  field: string,
): readonly ArtifactRefPayload[] {
  const value = payload[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ReducerError(event.eventId, event.type, `payload.${field} must be a non-empty array`);
  }
  return value.map((entry, index) => toArtifactRefPayload(event, entry, index));
}

/**
 * Pure. The keys `applyEvent` may read or write for this event — lets the
 * command load exactly the rows it needs instead of the whole projection.
 *
 * This must stay in step with `applyEvent`: a key the reducer reads but this
 * function omits would be absent from the scoped state and read as "does not
 * exist", turning a legitimate transition into a spurious `ReducerError`.
 */
export function eventScope(event: StateEvent): ProjectionScope {
  const payload = payloadObject(event);
  switch (event.type) {
    case "run.created": {
      const workspaceId = optionalWorkspaceId(event, payload);
      return {
        runs: [requireRunId(event, payload)],
        codebases: [requireString(event, payload, "codebaseId")],
        repositories: [],
        workspaces: workspaceId === null ? [] : [workspaceId],
        artifacts: [],
        stageArtifactAliases: [],
      };
    }
    case "run.status_changed":
      return {
        runs: [requireRunId(event, payload)],
        codebases: [],
        repositories: [],
        workspaces: [],
        artifacts: [],
        stageArtifactAliases: [],
      };
    case "run.workspace_assigned":
      return {
        runs: [requireRunId(event, payload)],
        codebases: [],
        repositories: [],
        workspaces: [requireString(event, payload, "workspaceId")],
        artifacts: [],
        stageArtifactAliases: [],
      };
    case "codebase.registered":
      return {
        runs: [],
        codebases: [requireString(event, payload, "codebaseId")],
        repositories: [],
        workspaces: [],
        artifacts: [],
        stageArtifactAliases: [],
      };
    case "repository.registered":
      return {
        runs: [],
        codebases: [requireString(event, payload, "codebaseId")],
        repositories: [requireString(event, payload, "repositoryId")],
        workspaces: [],
        artifacts: [],
        stageArtifactAliases: [],
      };
    case "workspace.registered":
      return {
        runs: [],
        codebases: [requireString(event, payload, "codebaseId")],
        repositories: [],
        workspaces: [requireString(event, payload, "workspaceId")],
        artifacts: [],
        stageArtifactAliases: [],
      };
    case "artifact.published": {
      requireRunId(event, payload);
      requireString(event, payload, "stageId");
      return {
        runs: [],
        codebases: [],
        repositories: [],
        workspaces: [],
        artifacts: [requireString(event, payload, "artifactId")],
        stageArtifactAliases: [],
      };
    }
    case "stage.completed": {
      const runId = requireRunId(event, payload);
      const stageId = requireString(event, payload, "stageId");
      const refs = requireArtifactRefs(event, payload, "artifacts");
      return {
        runs: [],
        codebases: [],
        repositories: [],
        workspaces: [],
        artifacts: refs.map((ref) => ref.artifactId),
        stageArtifactAliases: refs.map((ref) => ({ runId, stageId, name: ref.name })),
      };
    }
    default:
      throw new ReducerError(event.eventId, event.type, "unknown event type");
  }
}

/** Pure. No I/O, no clock, no randomness, no `DatabaseSync` in the signature. */
export const applyEvent: Reducer = (state, event) => {
  const payload = payloadObject(event);
  // Guard the run-scoped/identity split once, up front: a `run.*` event whose
  // row-level `run_id` is null (or an identity event that somehow carries
  // one) is malformed in a way every case below would otherwise have to
  // re-check.
  if (RUN_SCOPED_TYPES.has(event.type) && event.runId === null) {
    throw new ReducerError(event.eventId, event.type, "a run.* event must carry a run_id");
  }
  if (STAGE_SCOPED_TYPES.has(event.type) && event.runId === null) {
    throw new ReducerError(
      event.eventId,
      event.type,
      "an artifact/stage event must carry a run_id",
    );
  }

  switch (event.type) {
    case "run.created": {
      const runId = requireRunId(event, payload);
      if (state.runs[runId] !== undefined) {
        throw new ReducerError(event.eventId, event.type, `run already exists: ${runId}`);
      }
      return {
        ...state,
        runs: {
          ...state.runs,
          [runId]: {
            runId,
            status: "queued",
            revision: 1,
            lastEventSequence: event.sequence,
            workspaceId: optionalWorkspaceId(event, payload),
            codebaseId: requireString(event, payload, "codebaseId"),
            updatedAt: event.recordedAt,
          },
        },
      };
    }
    case "run.status_changed": {
      const runId = requireRunId(event, payload);
      const previous = state.runs[runId];
      if (previous === undefined) {
        throw new ReducerError(event.eventId, event.type, `run does not exist: ${runId}`);
      }
      const status = requireString(event, payload, "status");
      if (!isRunStatus(status)) {
        throw new ReducerError(event.eventId, event.type, `unknown run status: ${status}`);
      }
      return {
        ...state,
        runs: {
          ...state.runs,
          [runId]: {
            ...previous,
            status,
            revision: previous.revision + 1,
            lastEventSequence: event.sequence,
            updatedAt: event.recordedAt,
          },
        },
      };
    }
    case "run.workspace_assigned": {
      const runId = requireRunId(event, payload);
      const previous = state.runs[runId];
      if (previous === undefined) {
        throw new ReducerError(event.eventId, event.type, `run does not exist: ${runId}`);
      }
      const workspaceId = requireString(event, payload, "workspaceId");
      if (state.workspaces[workspaceId] === undefined) {
        throw new ReducerError(
          event.eventId,
          event.type,
          `workspace is not registered: ${workspaceId}`,
        );
      }
      return {
        ...state,
        runs: {
          ...state.runs,
          [runId]: {
            ...previous,
            revision: previous.revision + 1,
            lastEventSequence: event.sequence,
            workspaceId,
            updatedAt: event.recordedAt,
          },
        },
      };
    }
    case "codebase.registered": {
      const codebaseId = requireString(event, payload, "codebaseId");
      if (state.codebases[codebaseId] !== undefined) {
        throw new ReducerError(event.eventId, event.type, `codebase already exists: ${codebaseId}`);
      }
      return {
        ...state,
        codebases: {
          ...state.codebases,
          [codebaseId]: {
            codebaseId,
            revision: 1,
            lastEventSequence: event.sequence,
            updatedAt: event.recordedAt,
          },
        },
      };
    }
    case "repository.registered": {
      const repositoryId = requireString(event, payload, "repositoryId");
      const codebaseId = requireString(event, payload, "codebaseId");
      if (state.repositories[repositoryId] !== undefined) {
        throw new ReducerError(
          event.eventId,
          event.type,
          `repository already exists: ${repositoryId}`,
        );
      }
      if (state.codebases[codebaseId] === undefined) {
        throw new ReducerError(
          event.eventId,
          event.type,
          `codebase is not registered: ${codebaseId}`,
        );
      }
      return {
        ...state,
        repositories: {
          ...state.repositories,
          [repositoryId]: {
            repositoryId,
            codebaseId,
            revision: 1,
            lastEventSequence: event.sequence,
            updatedAt: event.recordedAt,
          },
        },
      };
    }
    case "workspace.registered": {
      const workspaceId = requireString(event, payload, "workspaceId");
      const codebaseId = requireString(event, payload, "codebaseId");
      if (state.workspaces[workspaceId] !== undefined) {
        throw new ReducerError(
          event.eventId,
          event.type,
          `workspace already exists: ${workspaceId}`,
        );
      }
      if (state.codebases[codebaseId] === undefined) {
        throw new ReducerError(
          event.eventId,
          event.type,
          `codebase is not registered: ${codebaseId}`,
        );
      }
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            workspaceId,
            codebaseId,
            revision: 1,
            lastEventSequence: event.sequence,
            updatedAt: event.recordedAt,
          },
        },
      };
    }
    case "artifact.published": {
      const runId = requireRunId(event, payload);
      const stageId = requireString(event, payload, "stageId");
      const artifactId = requireString(event, payload, "artifactId");
      if (state.artifacts[artifactId] !== undefined) {
        throw new ReducerError(event.eventId, event.type, `artifact already exists: ${artifactId}`);
      }
      const name = requireString(event, payload, "name");
      const contentHash = requireString(event, payload, "contentHash");
      const byteLength = requireNonNegativeInteger(event, payload, "byteLength");
      const mediaType = requireString(event, payload, "mediaType");
      const contentSchemaId = requireString(event, payload, "contentSchemaId");
      const producer = requireString(event, payload, "producer");
      const sourceLineage = requireStringArray(event, payload, "sourceLineage");
      const relativePath = requireString(event, payload, "relativePath");
      return {
        ...state,
        artifacts: {
          ...state.artifacts,
          [artifactId]: {
            artifactId,
            runId,
            stageId,
            name,
            contentHash,
            byteLength,
            mediaType,
            contentSchemaId,
            producer,
            sourceLineage,
            relativePath,
            createdAt: event.recordedAt,
            revision: 1,
            lastEventSequence: event.sequence,
          },
        },
      };
    }
    case "stage.completed": {
      // Design D4 / N (model (a) from the plan-review discussion): one event,
      // whose reducer writes into two tables — a new `artifact` row per
      // published ref, plus the `stage_artifact_alias` row that re-points
      // that name at the newly published artifact. This is what forces
      // Phase 4's `primaryTable` fix (Task 4.1): `TABLE_ORDER` sorts
      // `artifact` before `stage_artifact_alias`, so `reported[0]` alone
      // would report the wrong row's revision.
      const runId = requireRunId(event, payload);
      const stageId = requireString(event, payload, "stageId");
      const refs = requireArtifactRefs(event, payload, "artifacts");

      const seenNames = new Set<string>();
      for (const ref of refs) {
        if (seenNames.has(ref.name)) {
          throw new ReducerError(
            event.eventId,
            event.type,
            `payload.artifacts has more than one entry named "${ref.name}"`,
          );
        }
        seenNames.add(ref.name);
        if (state.artifacts[ref.artifactId] !== undefined) {
          throw new ReducerError(
            event.eventId,
            event.type,
            `artifact already exists: ${ref.artifactId}`,
          );
        }
      }

      let artifacts = state.artifacts;
      let stageArtifactAliases = state.stageArtifactAliases;
      for (const ref of refs) {
        artifacts = {
          ...artifacts,
          [ref.artifactId]: {
            artifactId: ref.artifactId,
            runId,
            stageId,
            name: ref.name,
            contentHash: ref.contentHash,
            byteLength: ref.byteLength,
            mediaType: ref.mediaType,
            contentSchemaId: ref.contentSchemaId,
            producer: ref.producer,
            sourceLineage: ref.sourceLineage,
            relativePath: ref.relativePath,
            createdAt: event.recordedAt,
            revision: 1,
            lastEventSequence: event.sequence,
          },
        };
        const aliasKey = stageArtifactAliasKey(runId, stageId, ref.name);
        const previousAlias = stageArtifactAliases[aliasKey];
        stageArtifactAliases = {
          ...stageArtifactAliases,
          [aliasKey]: {
            runId,
            stageId,
            name: ref.name,
            artifactId: ref.artifactId,
            revision: (previousAlias?.revision ?? 0) + 1,
            lastEventSequence: event.sequence,
            updatedAt: event.recordedAt,
          },
        };
      }
      return { ...state, artifacts, stageArtifactAliases };
    }
    default:
      throw new ReducerError(event.eventId, event.type, "unknown event type");
  }
};
