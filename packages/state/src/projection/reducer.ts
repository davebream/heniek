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

export type Reducer = (state: ProjectionState, event: StateEvent) => ProjectionState;

/** The six-member vocabulary (P3) — the minimum that exercises the run projection, the identity rows, and a relationship. */
const RUN_SCOPED_TYPES = new Set(["run.created", "run.status_changed", "run.workspace_assigned"]);

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
      };
    }
    case "run.status_changed":
      return {
        runs: [requireRunId(event, payload)],
        codebases: [],
        repositories: [],
        workspaces: [],
      };
    case "run.workspace_assigned":
      return {
        runs: [requireRunId(event, payload)],
        codebases: [],
        repositories: [],
        workspaces: [requireString(event, payload, "workspaceId")],
      };
    case "codebase.registered":
      return {
        runs: [],
        codebases: [requireString(event, payload, "codebaseId")],
        repositories: [],
        workspaces: [],
      };
    case "repository.registered":
      return {
        runs: [],
        codebases: [requireString(event, payload, "codebaseId")],
        repositories: [requireString(event, payload, "repositoryId")],
        workspaces: [],
      };
    case "workspace.registered":
      return {
        runs: [],
        codebases: [requireString(event, payload, "codebaseId")],
        repositories: [],
        workspaces: [requireString(event, payload, "workspaceId")],
      };
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
    default:
      throw new ReducerError(event.eventId, event.type, "unknown event type");
  }
};
