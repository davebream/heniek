/**
 * Maps runner failure classifications (and optional backend classes) onto
 * PipelineFailure categories with the §24 upper-bound retry rule.
 */

export type PipelineFailureCategory =
  | "transient"
  | "provider"
  | "validation"
  | "conflict"
  | "security"
  | "terminal";

export interface ClassifyFailureInput {
  readonly classification: string;
  readonly phase: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly backendClassification?: string;
  readonly validationFailures?: readonly string[];
}

export interface PipelineFailurePlain {
  readonly schemaVersion: 1;
  readonly category: PipelineFailureCategory;
  readonly classification: string;
  readonly phase: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly runnerRetryable: boolean;
  readonly backendClassification?: string;
  readonly validationFailures?: readonly string[];
}

const PROVIDER_BACKEND = new Set([
  "account_unavailable",
  "profile_unavailable",
  "model_unavailable",
  "engine_unavailable",
  "provider_throttled",
  "context_capacity_exhausted",
]);

const SECURITY_BACKEND = new Set(["authentication_failed", "permission_denied"]);

const TERMINAL_BACKEND = new Set([
  "hard_limit_exceeded",
  "cancelled",
  "invalid_request",
  "ambiguous",
  "unknown",
]);

const CONFLICT = new Set([
  "stale_revision",
  "stale_sha",
  "merge_conflict",
  "reconciliation_required",
]);

const VALIDATION = new Set(["validation_failed", "collection_failed", "finalize_failed"]);

const TRANSIENT = new Set([
  "timeout",
  "process_failed",
  "prepare_failed",
  "start_failed",
  "workspace_failed",
  "recovery_required",
  "operation_failed",
]);

const TERMINAL_CLASS = new Set(["cancelled", "rejected", "unknown", "malformed_contract"]);

function mapCategory(input: ClassifyFailureInput): PipelineFailureCategory {
  const backend = input.backendClassification;
  if (backend !== undefined && SECURITY_BACKEND.has(backend)) {
    return "security";
  }
  if (backend !== undefined && TERMINAL_BACKEND.has(backend)) {
    return "terminal";
  }

  const classification = input.classification;
  if (TERMINAL_CLASS.has(classification)) {
    return "terminal";
  }
  if (CONFLICT.has(classification)) {
    return "conflict";
  }
  if (VALIDATION.has(classification)) {
    return "validation";
  }
  if (
    classification === "profile_failed" ||
    classification === "forge_failed" ||
    (classification === "backend_failed" && backend !== undefined && PROVIDER_BACKEND.has(backend))
  ) {
    return "provider";
  }
  if (
    TRANSIENT.has(classification) ||
    (classification === "backend_failed" &&
      (backend === undefined || (!PROVIDER_BACKEND.has(backend) && !SECURITY_BACKEND.has(backend))))
  ) {
    return "transient";
  }
  return "terminal";
}

/**
 * Classify a runner failure into a policy-facing PipelineFailure. Security and
 * terminal categories are never retryable regardless of the runner flag.
 */
export function classifyFailure(input: ClassifyFailureInput): PipelineFailurePlain {
  const category = mapCategory(input);
  const runnerRetryable = input.retryable;
  const retryable = runnerRetryable && category !== "security" && category !== "terminal";

  const failure: PipelineFailurePlain = {
    schemaVersion: 1,
    category,
    classification: input.classification,
    phase: input.phase,
    code: input.code,
    retryable,
    runnerRetryable,
  };
  if (input.backendClassification !== undefined) {
    (failure as { backendClassification?: string }).backendClassification =
      input.backendClassification;
  }
  if (input.validationFailures !== undefined) {
    (failure as { validationFailures?: readonly string[] }).validationFailures = [
      ...input.validationFailures,
    ];
  }
  return failure;
}
