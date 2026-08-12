import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  ParentHandoffV1,
  SCHEMA_REGISTRY,
  TaskContextV1,
  TaskHierarchyV1,
  TaskRevisionDocumentV1,
  TaskRevisionV1,
  TaskSourceSnapshotV1,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
for (const [id, schema] of SCHEMA_REGISTRY) ajv.addSchema(schema, id);

describe("Q039 task-source contracts", () => {
  it("registers the complete versioned task-source family", () => {
    expect([
      ParentHandoffV1.$id,
      TaskSourceSnapshotV1.$id,
      TaskRevisionDocumentV1.$id,
      TaskRevisionV1.$id,
      TaskHierarchyV1.$id,
      TaskContextV1.$id,
    ]).toEqual([
      "heniek://contract/ParentHandoff/v1",
      "heniek://contract/TaskSourceSnapshot/v1",
      "heniek://contract/TaskRevisionDocument/v1",
      "heniek://contract/TaskRevision/v1",
      "heniek://contract/TaskHierarchy/v1",
      "heniek://contract/TaskContext/v1",
    ]);
    for (const schema of [
      ParentHandoffV1,
      TaskSourceSnapshotV1,
      TaskRevisionDocumentV1,
      TaskRevisionV1,
      TaskHierarchyV1,
      TaskContextV1,
    ]) {
      expect(ajv.getSchema(schema.$id ?? "")).toBeTypeOf("function");
    }
  });

  it("preserves verbatim requirements and rejects unknown handoff fields", () => {
    const handoff = {
      schemaVersion: 1,
      objective: "Ship source ingestion.",
      constraints: ["Keep the exact spacing:  two spaces."],
      decisions: [
        { statement: "Use JSON Patch.", author: "maintainer", rationale: "Interoperability." },
      ],
      openQuestions: [],
      repositoryReferences: ["davebream/heniek"],
      requirements: [
        {
          requirementId: "R-1",
          text: "Must retain **Markdown** verbatim.",
          sourcePointer: "/body/1",
        },
      ],
    };
    const validate = ajv.getSchema(ParentHandoffV1.$id ?? "");
    expect(validate?.(handoff), JSON.stringify(validate?.errors)).toBe(true);
    expect(validate?.({ ...handoff, transcript: "forbidden" })).toBe(false);
  });

  it("keeps tracker edges and execution mappings structurally distinct", () => {
    const hierarchy = {
      schemaVersion: 1,
      rootSourceWorkItemId: "source-root",
      trackerEdges: [
        { parentSourceWorkItemId: "source-root", childSourceWorkItemId: "source-child" },
      ],
      executionMappings: [
        { sourceWorkItemId: "source-root", executionTaskIds: ["execution-a", "execution-b"] },
      ],
      recordedAt: "2026-08-12T08:00:00.000Z",
    };
    const validate = ajv.getSchema(TaskHierarchyV1.$id ?? "");
    expect(validate?.(hierarchy), JSON.stringify(validate?.errors)).toBe(true);
    expect(validate?.({ ...hierarchy, dependencies: ["execution-a"] })).toBe(false);
  });
});
