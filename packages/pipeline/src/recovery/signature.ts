/**
 * Canonical failure fingerprints for unchanged-signature exhaustion.
 */

import { createHash } from "node:crypto";
import type { PipelineFailureCategory, PipelineFailurePlain } from "./classify.js";

export interface PipelineFailureSignaturePlain {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly category: PipelineFailureCategory;
  readonly classification: string;
  readonly phase: string;
  readonly code: string;
  readonly backendClassification?: string;
  readonly validationFailures?: readonly string[];
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function canonicalStringify(value: JsonValue): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(",")}]`;
  }
  const record = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const entry = record[key];
    if (entry === undefined) {
      continue;
    }
    parts.push(`${JSON.stringify(key)}:${canonicalStringify(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Build a stable failure signature. Volatile fields (message, timestamps) are
 * excluded; validationFailures are sorted lexicographically before hashing.
 */
export function buildFailureSignature(
  failure: Pick<
    PipelineFailurePlain,
    | "category"
    | "classification"
    | "phase"
    | "code"
    | "backendClassification"
    | "validationFailures"
  >,
): PipelineFailureSignaturePlain {
  const validationFailures =
    failure.validationFailures === undefined
      ? undefined
      : [...failure.validationFailures].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        );

  const payload: { readonly [key: string]: JsonValue } = {
    category: failure.category,
    classification: failure.classification,
    phase: failure.phase,
    code: failure.code,
  };
  if (failure.backendClassification !== undefined) {
    (payload as { backendClassification?: string }).backendClassification =
      failure.backendClassification;
  }
  if (validationFailures !== undefined) {
    (payload as { validationFailures?: string[] }).validationFailures = validationFailures;
  }

  const digest = createHash("sha256").update(canonicalStringify(payload), "utf8").digest("hex");

  const signature: PipelineFailureSignaturePlain = {
    schemaVersion: 1,
    digest,
    category: failure.category,
    classification: failure.classification,
    phase: failure.phase,
    code: failure.code,
  };
  if (failure.backendClassification !== undefined) {
    (signature as { backendClassification?: string }).backendClassification =
      failure.backendClassification;
  }
  if (validationFailures !== undefined) {
    (signature as { validationFailures?: readonly string[] }).validationFailures =
      validationFailures;
  }
  return signature;
}
