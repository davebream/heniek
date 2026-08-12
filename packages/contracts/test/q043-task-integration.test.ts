import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  EpicRepositoryBranchV1,
  SCHEMA_REGISTRY,
  TaskIntegrationLedgerEntryV1,
  TaskIntegrationTraceV1,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
for (const [id, schema] of SCHEMA_REGISTRY) ajv.addSchema(schema, id);

describe("Q043 task integration contracts", () => {
  it("registers additive branch, ledger, and trace contracts", () => {
    for (const schema of [
      EpicRepositoryBranchV1,
      TaskIntegrationLedgerEntryV1,
      TaskIntegrationTraceV1,
    ]) {
      expect(ajv.getSchema(schema.$id ?? "")).toBeTypeOf("function");
    }
    expect(EpicRepositoryBranchV1.$id).toBe("heniek://contract/EpicRepositoryBranch/v1");
    expect(TaskIntegrationLedgerEntryV1.$id).toBe(
      "heniek://contract/TaskIntegrationLedgerEntry/v1",
    );
    expect(TaskIntegrationTraceV1.$id).toBe("heniek://contract/TaskIntegrationTrace/v1");
  });
});
