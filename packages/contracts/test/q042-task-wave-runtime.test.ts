import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_REGISTRY,
  TaskCapacityLeaseV1,
  TaskDispatchRecordV1,
  TaskLifecycleProjectionV1,
  TaskPropagationReasonV1,
  TaskWaveAuditEventV1,
  TaskWavePlanningSnapshotV1,
  TaskWavePlanningSnapshotV2,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
for (const [id, schema] of SCHEMA_REGISTRY) ajv.addSchema(schema, id);

describe("Q042 task-wave runtime contracts", () => {
  it("adds V2 planning and runtime contracts without replacing V1", () => {
    expect(TaskWavePlanningSnapshotV1.$id).toBe("heniek://contract/TaskWavePlanningSnapshot/v1");
    expect(TaskWavePlanningSnapshotV2.$id).toBe("heniek://contract/TaskWavePlanningSnapshot/v2");
    for (const schema of [
      TaskWavePlanningSnapshotV2,
      TaskLifecycleProjectionV1,
      TaskPropagationReasonV1,
      TaskCapacityLeaseV1,
      TaskDispatchRecordV1,
      TaskWaveAuditEventV1,
    ]) {
      expect(ajv.getSchema(schema.$id ?? "")).toBeTypeOf("function");
    }
  });

  it("validates transitive block provenance", () => {
    const validate = ajv.getSchema(TaskPropagationReasonV1.$id ?? "");
    expect(
      validate?.({
        schemaVersion: 1,
        code: "predecessor_blocked",
        immediateTaskId: "task-b",
        rootTaskId: "task-a",
        path: ["task-a", "task-b", "task-c"],
      }),
      JSON.stringify(validate?.errors),
    ).toBe(true);
  });
});
