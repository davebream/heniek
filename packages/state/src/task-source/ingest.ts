import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import type {
  ExecutionTaskId,
  ParentHandoff,
  SourceWorkItemId,
  TaskContext,
  TaskHierarchy,
  TaskRevision,
  TaskRevisionDocument,
  TaskRevisionId,
  TaskSource,
  TaskSourceSnapshot,
  TaskSourceSnapshotId,
} from "@heniek/contracts";
import { ParentHandoffV1 } from "@heniek/contracts";
import { Value } from "@sinclair/typebox/value";
import { publishArtifact } from "../artifact/publish.js";
import type { ArtifactStore } from "../artifact/store.js";
import type { Clock, IdGenerator } from "../determinism.js";
import type { JsonValue } from "../json.js";
import { stringifyCanonical } from "../json.js";
import type { JsonPatchOperation } from "./json-patch.js";
import { applyTaskRevisionPatch } from "./json-patch.js";
import type { TaskSourceStateStore } from "./store.js";

const SOURCE_KINDS = new Set([
  "parent_conversation",
  "manual_text",
  "github_issue",
  "github_pull_request",
  "local_file",
  "existing_branch_or_pr",
] as const);

type TaskSourceKind = TaskSourceSnapshot["sourceKind"];

export interface TaskSourceAttachmentInput {
  readonly uri: string;
  readonly name: string;
  readonly mediaType: string;
  readonly observedVersion?: string;
  readonly content: string | Uint8Array;
}

export interface TaskHierarchyInput {
  readonly trackerEdges?: readonly {
    readonly parentSourceWorkItemId: SourceWorkItemId;
    readonly childSourceWorkItemId: SourceWorkItemId;
  }[];
  readonly executionMappings?: readonly {
    readonly sourceWorkItemId: SourceWorkItemId;
    readonly executionTaskIds: readonly ExecutionTaskId[];
  }[];
}

export interface TaskSourceIngestionInput {
  readonly sourceWorkItemId: SourceWorkItemId;
  readonly sourceKind: TaskSourceKind;
  readonly sourceUri: string;
  readonly observedVersion: string;
  readonly rawContent: string | Uint8Array;
  readonly handoff: ParentHandoff;
  readonly attachments?: readonly TaskSourceAttachmentInput[];
  readonly hierarchy?: TaskHierarchyInput;
  readonly author: string;
  readonly reason: string;
}

export class TaskSourceInputError extends Error {
  override readonly name = "TaskSourceInputError";
}

export class TaskSourceConflictError extends Error {
  override readonly name = "TaskSourceConflictError";
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function sha256(value: Uint8Array | JsonValue): string {
  const encoded =
    value instanceof Uint8Array ? value : new TextEncoder().encode(stringifyCanonical(value));
  return createHash("sha256").update(encoded).digest("hex");
}

function parseInput(input: unknown): TaskSourceIngestionInput {
  if (typeof input !== "object" || input === null)
    throw new TaskSourceInputError("input must be an object");
  const value = input as Partial<TaskSourceIngestionInput>;
  if (
    typeof value.sourceWorkItemId !== "string" ||
    typeof value.sourceKind !== "string" ||
    !SOURCE_KINDS.has(value.sourceKind as TaskSourceKind) ||
    typeof value.sourceUri !== "string" ||
    value.sourceUri.length === 0 ||
    typeof value.observedVersion !== "string" ||
    value.observedVersion.length === 0 ||
    !(typeof value.rawContent === "string" || value.rawContent instanceof Uint8Array) ||
    typeof value.author !== "string" ||
    value.author.length === 0 ||
    typeof value.reason !== "string" ||
    value.reason.length === 0 ||
    !Value.Check(ParentHandoffV1, value.handoff)
  ) {
    throw new TaskSourceInputError(
      "input does not satisfy the provider-neutral task-source contract",
    );
  }
  for (const attachment of value.attachments ?? []) {
    if (
      typeof attachment.uri !== "string" ||
      attachment.uri.length === 0 ||
      typeof attachment.name !== "string" ||
      attachment.name.length === 0 ||
      typeof attachment.mediaType !== "string" ||
      attachment.mediaType.length === 0 ||
      !(typeof attachment.content === "string" || attachment.content instanceof Uint8Array)
    ) {
      throw new TaskSourceInputError("attachment does not satisfy the task-source contract");
    }
  }
  return value as TaskSourceIngestionInput;
}

function documentFrom(handoff: ParentHandoff): TaskRevisionDocument {
  return {
    schemaVersion: 1,
    objective: handoff.objective,
    constraints: [...handoff.constraints],
    decisions: [...handoff.decisions],
    openQuestions: [...handoff.openQuestions],
    repositoryReferences: [...handoff.repositoryReferences],
    requirements: [...handoff.requirements],
  };
}

function diff(previous: TaskRevisionDocument, next: TaskRevisionDocument): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [];
  for (const key of [
    "objective",
    "constraints",
    "decisions",
    "openQuestions",
    "repositoryReferences",
    "requirements",
  ] as const) {
    const before = previous[key] as unknown as JsonValue;
    const after = next[key] as unknown as JsonValue;
    if (stringifyCanonical(before) !== stringifyCanonical(after)) {
      operations.push({
        op: "replace",
        path: `/${key}`,
        value: structuredClone(after) as never,
      });
    }
  }
  return operations;
}

function hierarchyFor(input: TaskSourceIngestionInput, recordedAt: string): TaskHierarchy {
  const trackerEdges = [...(input.hierarchy?.trackerEdges ?? [])];
  const seenEdges = new Set<string>();
  const children = new Map<SourceWorkItemId, SourceWorkItemId[]>();
  for (const edge of trackerEdges) {
    if (edge.parentSourceWorkItemId === edge.childSourceWorkItemId)
      throw new TaskSourceInputError("tracker hierarchy cannot contain a self edge");
    const key = `${edge.parentSourceWorkItemId}\u0000${edge.childSourceWorkItemId}`;
    if (seenEdges.has(key))
      throw new TaskSourceInputError("tracker hierarchy contains a duplicate edge");
    seenEdges.add(key);
    const outgoing = children.get(edge.parentSourceWorkItemId) ?? [];
    outgoing.push(edge.childSourceWorkItemId);
    children.set(edge.parentSourceWorkItemId, outgoing);
  }
  const visiting = new Set<SourceWorkItemId>();
  const visited = new Set<SourceWorkItemId>();
  function visit(item: SourceWorkItemId): void {
    if (visiting.has(item)) throw new TaskSourceInputError("tracker hierarchy contains a cycle");
    if (visited.has(item)) return;
    visiting.add(item);
    for (const child of children.get(item) ?? []) visit(child);
    visiting.delete(item);
    visited.add(item);
  }
  for (const item of children.keys()) visit(item);

  return {
    schemaVersion: 1,
    rootSourceWorkItemId: input.sourceWorkItemId,
    trackerEdges,
    executionMappings: (input.hierarchy?.executionMappings ?? []).map((mapping) => ({
      sourceWorkItemId: mapping.sourceWorkItemId,
      executionTaskIds: [...mapping.executionTaskIds],
    })),
    recordedAt,
  };
}

export function createTaskIngestionSource(deps: {
  readonly artifacts: ArtifactStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly state: TaskSourceStateStore;
}): TaskSource {
  return {
    async load(unknownInput): Promise<TaskContext> {
      const input = parseInput(unknownInput);
      const rawBytes = bytes(input.rawContent);
      const contentSha256 = sha256(rawBytes);
      const attachmentDigests = (input.attachments ?? []).map((attachment) => ({
        input: attachment,
        bytes: bytes(attachment.content),
        hash: sha256(bytes(attachment.content)),
      }));
      const existingObservation = deps.state.findObservation(
        input.sourceUri,
        input.observedVersion,
      );
      if (existingObservation !== undefined) {
        const expectedAttachments = attachmentDigests.map(({ input: attachment, hash }) => ({
          uri: attachment.uri,
          name: attachment.name,
          mediaType: attachment.mediaType,
          observedVersion: attachment.observedVersion ?? null,
          contentSha256: hash,
        }));
        const actualAttachments = existingObservation.snapshot.attachments.map(
          ({ artifactId: _artifactId, ...attachment }) => attachment,
        );
        if (
          existingObservation.snapshot.sourceWorkItemId !== input.sourceWorkItemId ||
          existingObservation.snapshot.contentSha256 !== contentSha256 ||
          stringifyCanonical(existingObservation.snapshot.requirements as unknown as JsonValue) !==
            stringifyCanonical(input.handoff.requirements as unknown as JsonValue) ||
          stringifyCanonical(actualAttachments as unknown as JsonValue) !==
            stringifyCanonical(expectedAttachments as unknown as JsonValue)
        ) {
          throw new TaskSourceConflictError(
            "observed source version was reused with different content",
          );
        }
        const context = deps.state.load(input.sourceWorkItemId);
        if (context === undefined)
          throw new TaskSourceConflictError("stored observation has no active revision");
        return context;
      }

      const previous = deps.state.load(input.sourceWorkItemId);
      if (
        previous !== undefined &&
        (previous.snapshot.sourceUri !== input.sourceUri ||
          previous.snapshot.sourceKind !== input.sourceKind)
      ) {
        throw new TaskSourceConflictError("source identity cannot change across revisions");
      }

      const rawReceipt = publishArtifact(deps.artifacts, {
        bytes: rawBytes,
        expectedContentHash: contentSha256,
      });
      closeSync(rawReceipt.fd);
      const attachmentRelativePaths: Record<string, string> = Object.create(null) as Record<
        string,
        string
      >;
      const attachments: TaskSourceSnapshot["attachments"] = [];
      for (const attachment of attachmentDigests) {
        const receipt = publishArtifact(deps.artifacts, {
          bytes: attachment.bytes,
          expectedContentHash: attachment.hash,
        });
        closeSync(receipt.fd);
        attachmentRelativePaths[receipt.artifactId] = receipt.relativePath;
        attachments.push({
          uri: attachment.input.uri,
          name: attachment.input.name,
          mediaType: attachment.input.mediaType,
          observedVersion: attachment.input.observedVersion ?? null,
          contentSha256: attachment.hash,
          artifactId: receipt.artifactId,
        });
      }

      const now = deps.clock.nowIso();
      const snapshot: TaskSourceSnapshot = {
        schemaVersion: 1,
        snapshotId: deps.ids.next("source-snapshot") as TaskSourceSnapshotId,
        sourceWorkItemId: input.sourceWorkItemId,
        sourceKind: input.sourceKind,
        sourceUri: input.sourceUri,
        observedVersion: input.observedVersion,
        contentSha256,
        rawContentRef: rawReceipt.artifactId,
        requirements: [...input.handoff.requirements],
        attachments,
        observedAt: now,
      };
      const document = documentFrom(input.handoff);
      const patch = previous === undefined ? [] : diff(previous.activeRevision.document, document);
      if (previous !== undefined) {
        const reconstructed = applyTaskRevisionPatch(previous.activeRevision.document, patch);
        if (
          stringifyCanonical(reconstructed as unknown as JsonValue) !==
          stringifyCanonical(document as unknown as JsonValue)
        ) {
          throw new TaskSourceInputError("revision patch does not reconstruct the new document");
        }
      }
      const revision: TaskRevision = {
        schemaVersion: 1,
        revisionId: deps.ids.next("task-revision") as TaskRevisionId,
        sourceWorkItemId: input.sourceWorkItemId,
        ordinal: (previous?.activeRevision.ordinal ?? 0) + 1,
        revisionSha256: sha256(document as unknown as JsonValue),
        predecessorRevisionId: previous?.activeRevision.revisionId ?? null,
        predecessorRevisionSha256: previous?.activeRevision.revisionSha256 ?? null,
        sourceSnapshotId: snapshot.snapshotId,
        author: input.author,
        reason: input.reason,
        patch,
        document,
        supersessionState: "active",
        supersededByRevisionId: null,
        createdAt: now,
      };
      return deps.state.record({
        snapshot,
        rawRelativePath: rawReceipt.relativePath,
        attachmentRelativePaths,
        revision,
        hierarchy: hierarchyFor(input, now),
      });
    },
  };
}
