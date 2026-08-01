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
import type { ArtifactState, ProjectionScope, ProjectionState } from "./state.js";
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

/**
 * One artifact ref, as carried inside an `artifact.published` or
 * `stage.completed` payload.
 *
 * **Bound to `ArtifactRefV1`'s field names (`@heniek/contracts`), not
 * independently re-derived (issue #8, Phase 2 fix cycle G2).** The field is
 * `path`, matching the contract exactly — an earlier version of this
 * interface named it `relativePath`, which no `ArtifactRefV1` payload ever
 * carries, so a real caller serialising a contract ref would fail every
 * `stage.completed`/`artifact.published` commit with "payload.relativePath
 * must be a string". `ArtifactState.relativePath` (`projection/state.ts`)
 * is a separate, internal storage-row field name and is unaffected — this
 * interface is the wire/payload shape only.
 *
 * Deliberately has **no** `createdAt` field, even though `ArtifactRefV1`
 * carries one (G4): every artifact/alias row's `createdAt`/`updatedAt` is
 * always `event.recordedAt`, the same rule every other projection row
 * follows (this file's header comment) — that is what keeps the projection
 * a strictly monotonic, replay-exact function of the journal. A
 * caller-supplied `createdAt` on the payload is therefore intentionally
 * never read, not merely omitted from validation; see `applyEvent`'s
 * `artifact.published`/`stage.completed` cases, which build every stored
 * row's `createdAt` from `event.recordedAt` alone.
 */
interface ArtifactRefPayload {
  readonly artifactId: string;
  readonly name: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly contentSchemaId: string;
  readonly producer: string;
  readonly sourceLineage: readonly string[];
  readonly path: string;
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
 * `stageArtifactAliasKey` (`projection/state.ts`) joins `runId`/`stageId`/
 * `name` with U+0000 to build `stage_artifact_alias`'s in-memory map key.
 * `commit.ts`'s composite-key UPDATE now binds the same three columns
 * separately (issue #8, Phase 2 fix cycle G1, F5), so the SQL side is
 * injective regardless of what these ids contain — but the in-memory key
 * stays a plain string join, and a `runId`/`stageId`/`name` that itself
 * contained U+0000 could still collide two distinct triples onto the same
 * in-memory key even though the two rows are distinct in the database.
 * Rejecting U+0000 here at the reducer boundary is what keeps the in-memory
 * key injective — the same guarantee the SQL fix restores on the storage
 * side.
 */
function requireNoNul(event: StateEvent, field: string, value: string): string {
  if (value.includes("\u0000")) {
    throw new ReducerError(
      event.eventId,
      event.type,
      `payload.${field} must not contain a NUL character`,
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
  const runId = requireNoNul(event, "runId", requireString(event, payload, "runId"));
  if (event.runId !== runId) {
    throw new ReducerError(
      event.eventId,
      event.type,
      "payload.runId does not match the event's run_id",
    );
  }
  return runId;
}

/** `stageId` (F5) — same U+0000 rejection as `requireRunId`, see `requireNoNul`. */
function requireStageId(event: StateEvent, payload: Readonly<Record<string, JsonValue>>): string {
  return requireNoNul(event, "stageId", requireString(event, payload, "stageId"));
}

/** `name` (F5) — same U+0000 rejection as `requireRunId`, see `requireNoNul`. */
function requireName(event: StateEvent, payload: Readonly<Record<string, JsonValue>>): string {
  return requireNoNul(event, "name", requireString(event, payload, "name"));
}

/**
 * `content_hash`'s CHECK constraint (migration 4, issue #8 fix cycle G1, F1)
 * closes the alphabet to `[0-9a-f]{64}` at the schema layer so
 * `relative_path = 'blobs/sha256/' || content_hash` can never denote a path
 * outside the blob root. Validating the same shape here means a malformed
 * `contentHash` raises a typed `ReducerError` at the public API boundary
 * instead of surfacing as a raw `SQLITE_CONSTRAINT_CHECK` from deep inside
 * `commitStateChange`.
 */
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

function requireContentHash(
  event: StateEvent,
  payload: Readonly<Record<string, JsonValue>>,
  field: string,
): string {
  const value = requireString(event, payload, field);
  if (!CONTENT_HASH_PATTERN.test(value)) {
    throw new ReducerError(
      event.eventId,
      event.type,
      `payload.${field} must be exactly 64 lowercase hex characters`,
    );
  }
  return value;
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
 * `ArtifactRefV1.sourceLineage` (`@heniek/contracts`) bounds the field to
 * `maxItems: 64` and `uniqueItems: true`, but nothing on the write path
 * enforced either bound (issue #8, Phase 2 fix cycle G3) — the column
 * `CHECK` is `json_valid(source_lineage)` alone, and `requireStringArray`
 * above only checks "array of strings". A 5,000-entry or duplicate-laden
 * lineage would persist and round-trip, defeating the 64 KiB
 * event-payload-cap arithmetic the contract's own docblock records. Never
 * echoes the lineage entries themselves in the error message (this
 * package's error house rule, `errors.ts`'s header comment) — only the
 * measured count, which is a derived, non-sensitive fact.
 */
const MAX_SOURCE_LINEAGE_ITEMS = 64;

function requireSourceLineage(
  event: StateEvent,
  payload: Readonly<Record<string, JsonValue>>,
  field: string,
): readonly string[] {
  const values = requireStringArray(event, payload, field);
  if (values.length > MAX_SOURCE_LINEAGE_ITEMS) {
    throw new ReducerError(
      event.eventId,
      event.type,
      `payload.${field} must not exceed ${MAX_SOURCE_LINEAGE_ITEMS} entries (got ${values.length})`,
    );
  }
  if (new Set(values).size !== values.length) {
    throw new ReducerError(
      event.eventId,
      event.type,
      `payload.${field} must not contain duplicate entries`,
    );
  }
  return values;
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
    name: requireName(event, value),
    contentHash: requireContentHash(event, value, "contentHash"),
    byteLength: requireNonNegativeInteger(event, value, "byteLength"),
    mediaType: requireString(event, value, "mediaType"),
    contentSchemaId: requireString(event, value, "contentSchemaId"),
    producer: requireString(event, value, "producer"),
    sourceLineage: requireSourceLineage(event, value, "sourceLineage"),
    path: requireString(event, value, "path"),
  };
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * F2's adopt-vs-conflict test: `stage.completed` may re-cite an
 * `artifactId` that already has a row (published incrementally by an
 * earlier `artifact.published`, or by a previous attempt at this same
 * `stage.completed`). Returns the name of the first field that differs, or
 * `null` if `existing` is field-for-field identical to what this ref would
 * have written — the caller adopts on `null`, throws naming the mismatch
 * otherwise. `createdAt`/`revision`/`lastEventSequence` are deliberately
 * excluded from the comparison: those are event-provenance fields the
 * *first* writer set, not part of the artifact's own identity, and an
 * adopt is expected to cite a different (later) event than the original
 * insert.
 */
function artifactMismatchField(
  existing: ArtifactState,
  runId: string,
  stageId: string,
  ref: ArtifactRefPayload,
): string | null {
  if (existing.runId !== runId) {
    return "runId";
  }
  if (existing.stageId !== stageId) {
    return "stageId";
  }
  if (existing.name !== ref.name) {
    return "name";
  }
  if (existing.contentHash !== ref.contentHash) {
    return "contentHash";
  }
  if (existing.byteLength !== ref.byteLength) {
    return "byteLength";
  }
  if (existing.mediaType !== ref.mediaType) {
    return "mediaType";
  }
  if (existing.contentSchemaId !== ref.contentSchemaId) {
    return "contentSchemaId";
  }
  if (existing.producer !== ref.producer) {
    return "producer";
  }
  if (!arraysEqual(existing.sourceLineage, ref.sourceLineage)) {
    return "sourceLineage";
  }
  if (existing.relativePath !== ref.path) {
    return "relativePath";
  }
  return null;
}

/**
 * `payload.artifacts` may be **empty** (issue #8, Phase 2 fix cycle G1, F8)
 * — a stage that legitimately produces no outputs must be able to complete.
 * The original shipped validation rejected a zero-length array, which made
 * that legitimate case unrepresentable; only "is this an array" is required
 * here, matching `requireStringArray`'s posture for every other array field
 * in this file.
 */
function requireArtifactRefs(
  event: StateEvent,
  payload: Readonly<Record<string, JsonValue>>,
  field: string,
): readonly ArtifactRefPayload[] {
  const value = payload[field];
  if (!Array.isArray(value)) {
    throw new ReducerError(event.eventId, event.type, `payload.${field} must be an array`);
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
      const runId = requireRunId(event, payload);
      requireStageId(event, payload);
      return {
        // `artifact.run_id REFERENCES run_projection(run_id)` (F4) — the run
        // row must be loaded so `applyEvent` can check it exists before
        // writing the artifact row.
        runs: [runId],
        codebases: [],
        repositories: [],
        workspaces: [],
        artifacts: [requireString(event, payload, "artifactId")],
        stageArtifactAliases: [],
      };
    }
    case "stage.completed": {
      const runId = requireRunId(event, payload);
      const stageId = requireStageId(event, payload);
      const refs = requireArtifactRefs(event, payload, "artifacts");
      return {
        // Same F4 rationale as `artifact.published` above.
        runs: [runId],
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
      // `artifact.run_id REFERENCES run_projection(run_id)` (F4) — mirrors
      // `repository.registered`'s `codebase is not registered` precedent
      // above: the FK is genuinely enforced at the database layer (`PRAGMA
      // foreign_keys = ON`, `database/open.ts`), but a reducer-side check
      // raises a typed `ReducerError` instead of a raw
      // `SQLITE_CONSTRAINT_FOREIGNKEY`.
      if (state.runs[runId] === undefined) {
        throw new ReducerError(event.eventId, event.type, `run does not exist: ${runId}`);
      }
      const stageId = requireStageId(event, payload);
      const artifactId = requireString(event, payload, "artifactId");
      if (state.artifacts[artifactId] !== undefined) {
        throw new ReducerError(event.eventId, event.type, `artifact already exists: ${artifactId}`);
      }
      const name = requireName(event, payload);
      const contentHash = requireContentHash(event, payload, "contentHash");
      const byteLength = requireNonNegativeInteger(event, payload, "byteLength");
      const mediaType = requireString(event, payload, "mediaType");
      const contentSchemaId = requireString(event, payload, "contentSchemaId");
      const producer = requireString(event, payload, "producer");
      const sourceLineage = requireSourceLineage(event, payload, "sourceLineage");
      // Wire field is `path` (`ArtifactRefV1`, G2); `relativePath` below is
      // the storage-row field name (`ArtifactState`, `projection/state.ts`)
      // — same value, different layer. `createdAt` is deliberately never
      // read from `payload` here (G4) — see `ArtifactRefPayload`'s header
      // comment.
      const path = requireString(event, payload, "path");
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
            relativePath: path,
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
      // Same F4 rationale as `artifact.published` above.
      if (state.runs[runId] === undefined) {
        throw new ReducerError(event.eventId, event.type, `run does not exist: ${runId}`);
      }
      const stageId = requireStageId(event, payload);
      const refs = requireArtifactRefs(event, payload, "artifacts");

      const seenNames = new Set<string>();
      let artifacts = state.artifacts;
      let stageArtifactAliases = state.stageArtifactAliases;
      for (const ref of refs) {
        if (seenNames.has(ref.name)) {
          throw new ReducerError(
            event.eventId,
            event.type,
            `payload.artifacts has more than one entry named "${ref.name}"`,
          );
        }
        seenNames.add(ref.name);

        // F2 (issue #8, Phase 2 fix cycle G1): an artifact published
        // incrementally by an earlier `artifact.published` (or a retried
        // `stage.completed`) may already have this exact row. Adopting it
        // idempotently — skip the INSERT, still advance the alias below —
        // is what makes Phase 3's "idempotent adopt" representable.
        // `artifact.published` itself keeps the strict always-throws
        // behaviour above: publishing is not activation, so there is no
        // adopt path there.
        const existing = artifacts[ref.artifactId];
        if (existing === undefined) {
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
              relativePath: ref.path,
              createdAt: event.recordedAt,
              revision: 1,
              lastEventSequence: event.sequence,
            },
          };
        } else {
          const mismatch = artifactMismatchField(existing, runId, stageId, ref);
          if (mismatch !== null) {
            throw new ReducerError(
              event.eventId,
              event.type,
              `artifact already exists with a different ${mismatch}: ${ref.artifactId}`,
            );
          }
          // Identical row already present — adopt idempotently, no INSERT.
        }

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
