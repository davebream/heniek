import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_REGISTRY,
  TaskIntegrationReconciliationObservationV1,
  TaskIntegrationReconciliationV1,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
for (const [id, schema] of SCHEMA_REGISTRY) ajv.addSchema(schema, id);

describe("Q044 task integration reconciliation contracts", () => {
  it("registers additive reconciliation and observation contracts", () => {
    expect(ajv.getSchema(TaskIntegrationReconciliationV1.$id ?? "")).toBeTypeOf("function");
    expect(ajv.getSchema(TaskIntegrationReconciliationObservationV1.$id ?? "")).toBeTypeOf(
      "function",
    );
    expect(TaskIntegrationReconciliationV1.$id).toBe(
      "heniek://contract/TaskIntegrationReconciliation/v1",
    );
    expect(TaskIntegrationReconciliationObservationV1.$id).toBe(
      "heniek://contract/TaskIntegrationReconciliationObservation/v1",
    );
  });

  it("keeps every Q043 generated schema byte-identical", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../generated/manifest.json", import.meta.url)), "utf8"),
    ) as { schemas: { path: string; sha256: string }[] };
    const q043Pins = new Map([
      [
        "EpicRepositoryBranch.v1.schema.json",
        "d029db045c767de7a30ac779e2a834badef534dcf4611d9328d296ab9488289d",
      ],
      [
        "TaskIntegrationLedgerEntry.v1.schema.json",
        "8a9f2a1cb1525ec90a1c816f88174efa749313ebdf42249579c0aa3793aa3a15",
      ],
      [
        "TaskIntegrationTrace.v1.schema.json",
        "e62e0881ac7a0ab06fd3192cffa029e338ddcce9bbcc6a9a49264ad469a389e7",
      ],
    ]);
    for (const [name, pinnedSha256] of q043Pins) {
      const entry = manifest.schemas.find((candidate) => candidate.path.endsWith(name));
      expect(entry).toBeDefined();
      const content = readFileSync(
        fileURLToPath(new URL(`../${entry?.path}`, import.meta.url)),
        "utf8",
      );
      expect(createHash("sha256").update(content).digest("hex")).toBe(pinnedSha256);
      expect(entry?.sha256).toBe(pinnedSha256);
    }
  });
});
