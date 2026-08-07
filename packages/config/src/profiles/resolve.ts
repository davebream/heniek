import { createHash } from "node:crypto";
import { ProfileConfigurationV1, type ResolvedProfileV1 } from "@heniek/contracts";
import { redactJson } from "@heniek/secrets";
import type { Static } from "@sinclair/typebox";
import { Ajv, type ErrorObject } from "ajv";
import { createDiagnostic, type Diagnostic, sortDiagnostics } from "../diagnostics.js";
import {
  canonicalJsonStringify,
  deepFreeze,
  type JsonObject,
  type JsonValue,
  joinPointer,
} from "../json.js";
import {
  type ConfigurationProvenance,
  HENIEK_BUILT_IN_CONFIGURATION_POLICY,
  hardLimitMagnitude,
  resolveConfiguration,
} from "../layers/index.js";
import {
  type Engine,
  type ExecutionMode,
  PROFILE_OVERRIDE_FIELDS,
  type ProfileCapabilityRow,
  type ProfileInvocationOverrides,
  type ProfileOverrideField,
  type ProfileResolutionResult,
  type ResolvedProfile,
  type ResolveProfileInput,
} from "./types.js";

type ProfileCatalog = Static<typeof ProfileConfigurationV1>;
type ProfileDefinition = NonNullable<ProfileCatalog["profiles"]>[string];
type AccountDefinition = NonNullable<ProfileCatalog["accounts"]>[string];

type ResolvedProfileContract = Static<typeof ResolvedProfileV1>;
type ProfileProvenance = ResolvedProfileContract["provenance"][number];

const ajv = new Ajv({ allErrors: true, strict: true });
const validateProfileCatalog = ajv.compile(ProfileConfigurationV1);
const DURATION_PATTERN = /^[1-9][0-9]*(?:ms|s|m|h|d)$/;
const ENGINE_VALUES = new Set<Engine>(["claude", "codex", "cursor"]);
const EXECUTION_MODE_VALUES = new Set<ExecutionMode>(["native", "external"]);
const OVERRIDE_FIELDS = new Set<string>(PROFILE_OVERRIDE_FIELDS);

interface EffectiveProfile {
  engine: Engine;
  account?: string;
  billing?: "subscription";
  model: string;
  effort: string;
  executionMode: ExecutionMode;
  focus?: string;
  maxDuration?: string;
  workspaceStrategy?: string;
}

function pointer(...segments: readonly string[]): string {
  return segments.reduce((result, segment) => joinPointer(result, segment), "");
}

function schemaErrorPointer(error: ErrorObject): string {
  if (error.keyword === "required") {
    const missing = (error.params as { readonly missingProperty?: unknown }).missingProperty;
    if (typeof missing === "string") {
      return joinPointer(error.instancePath, missing);
    }
  }
  return error.instancePath || "/";
}

function diagnosticText(value: unknown): string {
  const safe = redactJson(value);
  return typeof safe === "string" ? safe : (JSON.stringify(safe) ?? "[invalid]");
}

function quotedDiagnosticValue(value: unknown): string {
  return JSON.stringify(redactJson(value)) ?? '"[invalid]"';
}

function catalogSchemaDiagnostics(
  errors: readonly ErrorObject[],
  provenance: readonly ConfigurationProvenance[],
): readonly Diagnostic[] {
  return errors.map((error) => {
    const at = schemaErrorPointer(error);
    const source = provenance.find((entry) => entry.pointer === at);
    return createDiagnostic(
      "profile.configuration-invalid",
      "error",
      `Profile configuration at ${diagnosticText(at)} ${error.message ?? "is invalid"}.`,
      {
        pointer: at,
        ...(source?.sourcePath !== undefined ? { sourcePath: source.sourcePath } : {}),
      },
    );
  });
}

function profileCatalog(values: JsonObject): JsonObject {
  const result: Record<string, JsonValue> = { schemaVersion: 1 };
  for (const section of ["accounts", "workers", "roles", "profiles"] as const) {
    if (Object.hasOwn(values, section)) {
      result[section] = values[section] as JsonValue;
    }
  }
  return result;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function overrideValueIsValid(field: ProfileOverrideField, value: unknown): boolean {
  switch (field) {
    case "engine":
      return ENGINE_VALUES.has(value as Engine);
    case "executor":
      return EXECUTION_MODE_VALUES.has(value as ExecutionMode);
    case "billing":
      return value === "subscription";
    case "max_duration":
      return typeof value === "string" && DURATION_PATTERN.test(value);
    case "account":
    case "model":
    case "effort":
    case "focus":
    case "workspace_strategy":
      return isNonEmptyString(value);
  }
}

function isSensitive(value: unknown): boolean {
  return JSON.stringify(redactJson(value)) !== JSON.stringify(value);
}

function applyInvocationOverrides(
  effective: EffectiveProfile,
  profile: ProfileDefinition,
  overrides: ProfileInvocationOverrides | undefined,
  diagnostics: Diagnostic[],
): ReadonlySet<ProfileOverrideField> {
  const applied = new Set<ProfileOverrideField>();
  const record = (overrides ?? {}) as Readonly<Record<string, unknown>>;
  const allowed = new Set<string>(profile.overridable ?? []);

  for (const field of Object.keys(record).sort()) {
    const value = record[field];
    if (!OVERRIDE_FIELDS.has(field)) {
      diagnostics.push(
        createDiagnostic(
          "profile.override-unknown",
          "error",
          `Invocation override field ${quotedDiagnosticValue(field)} is not supported.`,
          { pointer: pointer("invocationOverrides", field) },
        ),
      );
      continue;
    }

    const typedField = field as ProfileOverrideField;
    if (!allowed.has(field)) {
      diagnostics.push(
        createDiagnostic(
          "profile.override-not-permitted",
          "error",
          `Invocation override field ${quotedDiagnosticValue(field)} is not declared overridable by this profile.`,
          { pointer: pointer("invocationOverrides", field) },
        ),
      );
      continue;
    }
    if (!overrideValueIsValid(typedField, value)) {
      diagnostics.push(
        createDiagnostic(
          "profile.override-invalid",
          "error",
          `Invocation override field ${quotedDiagnosticValue(field)} has an invalid value.`,
          { pointer: pointer("invocationOverrides", field) },
        ),
      );
      continue;
    }
    if (isSensitive(value)) {
      diagnostics.push(
        createDiagnostic(
          "profile.override-sensitive-value",
          "error",
          `Invocation override field ${quotedDiagnosticValue(field)} contains a credential-shaped value and was rejected.`,
          { pointer: pointer("invocationOverrides", field) },
        ),
      );
      continue;
    }

    switch (typedField) {
      case "engine":
        effective.engine = value as Engine;
        break;
      case "account":
        effective.account = value as string;
        break;
      case "billing":
        effective.billing = "subscription";
        break;
      case "model":
        effective.model = value as string;
        break;
      case "effort":
        effective.effort = value as string;
        break;
      case "executor":
        effective.executionMode = value as ExecutionMode;
        break;
      case "focus":
        effective.focus = value as string;
        break;
      case "max_duration":
        effective.maxDuration = value as string;
        break;
      case "workspace_strategy":
        effective.workspaceStrategy = value as string;
        break;
    }
    applied.add(typedField);
  }

  return applied;
}

function capabilityRowIsValid(row: ProfileCapabilityRow): boolean {
  return (
    ENGINE_VALUES.has(row.engine) &&
    (row.accountId === undefined || isNonEmptyString(row.accountId)) &&
    isNonEmptyString(row.model) &&
    Array.isArray(row.efforts) &&
    row.efforts.every(isNonEmptyString) &&
    Array.isArray(row.executionModes) &&
    row.executionModes.every((mode) => EXECUTION_MODE_VALUES.has(mode))
  );
}

function validateCapabilities(
  rows: readonly ProfileCapabilityRow[],
  effective: EffectiveProfile,
  accountId: string | undefined,
  diagnostics: Diagnostic[],
): void {
  const validRows: ProfileCapabilityRow[] = [];
  rows.forEach((row, index) => {
    if (!capabilityRowIsValid(row)) {
      diagnostics.push(
        createDiagnostic(
          "profile.capability-row-invalid",
          "error",
          `Capability row ${index} is invalid.`,
          { pointer: pointer("capabilities", String(index)) },
        ),
      );
      return;
    }
    validRows.push(row);
  });

  const modelRows = validRows.filter(
    (row) =>
      row.engine === effective.engine &&
      row.model === effective.model &&
      row.accountId === accountId,
  );
  if (modelRows.length === 0) {
    diagnostics.push(
      createDiagnostic(
        "profile.capability-not-found",
        "error",
        `No capability row matches engine ${quotedDiagnosticValue(effective.engine)}, account ${quotedDiagnosticValue(accountId ?? "<native>")}, and model ${quotedDiagnosticValue(effective.model)}.`,
        { pointer: "/capabilities" },
      ),
    );
    return;
  }

  const modeRows = modelRows.filter((row) => row.executionModes.includes(effective.executionMode));
  if (modeRows.length === 0) {
    diagnostics.push(
      createDiagnostic(
        "profile.execution-mode-unsupported",
        "error",
        `Execution mode ${quotedDiagnosticValue(effective.executionMode)} is not supported for the resolved engine/account/model.`,
        { pointer: "/executionMode" },
      ),
    );
    return;
  }

  if (!modeRows.some((row) => row.efforts.includes(effective.effort))) {
    diagnostics.push(
      createDiagnostic(
        "profile.effort-unsupported",
        "error",
        `Effort ${quotedDiagnosticValue(effective.effort)} is not supported for the resolved engine/account/model/mode.`,
        { pointer: "/effort" },
      ),
    );
  }
}

function redacted(value: unknown): JsonValue {
  return redactJson(value) as JsonValue;
}

function semanticProvenance(
  base: readonly ConfigurationProvenance[],
  field: string,
  sourcePointer: string,
  effectiveValue: JsonValue,
  overriddenAtInvocation: boolean,
): ProfileProvenance | undefined {
  const source = base.find((entry) => entry.pointer === sourcePointer);
  if (source === undefined && !overriddenAtInvocation) {
    return undefined;
  }

  if (overriddenAtInvocation) {
    const overridden =
      source === undefined
        ? []
        : [
            ...source.overridden.map((entry) => ({
              layer: entry.layer,
              ...(entry.sourcePath !== undefined ? { sourcePath: entry.sourcePath } : {}),
              value: redacted(entry.value),
            })),
            {
              layer: source.layer,
              ...(source.sourcePath !== undefined ? { sourcePath: source.sourcePath } : {}),
              value: redacted(source.value),
            },
          ];
    return {
      field,
      pointer: sourcePointer,
      layer: "invocation-override",
      value: redacted(effectiveValue),
      overridden,
    };
  }

  return {
    field,
    pointer: sourcePointer,
    layer: source?.layer ?? "profile-or-stage",
    ...(source?.sourcePath !== undefined ? { sourcePath: source.sourcePath } : {}),
    value: redacted(effectiveValue),
    overridden:
      source?.overridden.map((entry) => ({
        layer: entry.layer,
        ...(entry.sourcePath !== undefined ? { sourcePath: entry.sourcePath } : {}),
        value: redacted(entry.value),
      })) ?? [],
  };
}

function fingerprintFor(semantics: JsonObject): string {
  const canonical = canonicalJsonStringify(redactJson(semantics) as JsonObject);
  const digest = createHash("sha256")
    .update("ResolvedProfile.v1\0")
    .update(canonical)
    .digest("hex");
  return `sha256:${digest}`;
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function finalizedDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return sortDiagnostics(diagnostics).map(
    (diagnostic) => redactJson(diagnostic as unknown as JsonObject) as unknown as Diagnostic,
  );
}

function failure(diagnostics: readonly Diagnostic[]): ProfileResolutionResult {
  return deepFreeze({ ok: false, diagnostics: finalizedDiagnostics(diagnostics) });
}

function missingReference(code: string, kind: string, id: string, at: string): Diagnostic {
  return createDiagnostic(
    code,
    "error",
    `Referenced ${kind} ${quotedDiagnosticValue(id)} does not exist.`,
    {
      pointer: at,
    },
  );
}

/**
 * Resolves §9 configuration without filesystem or workspace access. A caller
 * can only receive a profile when every reference, override and capability
 * check passed.
 */
export function resolveProfile(input: ResolveProfileInput): ProfileResolutionResult {
  const diagnostics: Diagnostic[] = [];
  const baseDocuments = input.documents.filter((document) => {
    if (document.layer !== "invocation-override") {
      return true;
    }
    diagnostics.push(
      createDiagnostic(
        "profile.invocation-document-forbidden",
        "error",
        "Pass invocation overrides through the typed invocationOverrides input, not as a raw configuration document.",
        {
          ...(document.sourcePath !== undefined ? { sourcePath: document.sourcePath } : {}),
        },
      ),
    );
    return false;
  });

  const base = resolveConfiguration({
    documents: baseDocuments,
    policy: HENIEK_BUILT_IN_CONFIGURATION_POLICY,
  });
  diagnostics.push(...base.diagnostics);

  const candidate = profileCatalog(base.values);
  if (!validateProfileCatalog(candidate)) {
    diagnostics.push(
      ...catalogSchemaDiagnostics(validateProfileCatalog.errors ?? [], base.provenance),
    );
    return failure(diagnostics);
  }
  const catalog = candidate as ProfileCatalog;

  const profilePointer = pointer("profiles", input.profileId);
  const profile = catalog.profiles?.[input.profileId];
  if (profile === undefined) {
    diagnostics.push(
      createDiagnostic(
        "profile.not-found",
        "error",
        `Profile ${quotedDiagnosticValue(input.profileId)} does not exist.`,
        { pointer: profilePointer },
      ),
    );
    return failure(diagnostics);
  }

  const workerPointer = pointer("workers", profile.worker);
  const worker = catalog.workers?.[profile.worker];
  if (worker === undefined) {
    diagnostics.push(
      missingReference(
        "profile.worker-not-found",
        "worker",
        profile.worker,
        joinPointer(profilePointer, "worker"),
      ),
    );
  }
  const rolePointer = pointer("roles", profile.role);
  const role = catalog.roles?.[profile.role];
  if (role === undefined) {
    diagnostics.push(
      missingReference(
        "profile.role-not-found",
        "role",
        profile.role,
        joinPointer(profilePointer, "role"),
      ),
    );
  }
  if (worker === undefined || role === undefined) {
    return failure(diagnostics);
  }

  const effective: EffectiveProfile = {
    engine: worker.engine,
    ...(worker.account !== undefined ? { account: worker.account } : {}),
    model: worker.model,
    effort: worker.effort,
    executionMode: worker.executor,
    ...(profile.focus !== undefined ? { focus: profile.focus } : {}),
    ...(profile.max_duration !== undefined ? { maxDuration: profile.max_duration } : {}),
    ...(profile.workspace_strategy !== undefined
      ? { workspaceStrategy: profile.workspace_strategy }
      : {}),
  };

  const applied = applyInvocationOverrides(
    effective,
    profile,
    input.invocationOverrides,
    diagnostics,
  );

  let account: AccountDefinition | undefined;
  let accountPointer: string | undefined;
  if (effective.executionMode === "native") {
    if (effective.engine !== "claude") {
      diagnostics.push(
        createDiagnostic(
          "profile.native-engine-invalid",
          "error",
          "Native execution is supported only for the Claude engine.",
          { pointer: "/executionMode" },
        ),
      );
    }
    if (effective.account !== undefined) {
      diagnostics.push(
        createDiagnostic(
          "profile.native-account-forbidden",
          "error",
          "Native execution inherits the connected parent session and must not select an account.",
          {
            pointer: applied.has("account")
              ? pointer("invocationOverrides", "account")
              : joinPointer(workerPointer, "account"),
          },
        ),
      );
    }
    if (applied.has("account") || applied.has("billing")) {
      diagnostics.push(
        createDiagnostic(
          "profile.native-account-override-forbidden",
          "error",
          "Account and billing overrides do not apply to native execution.",
          { pointer: "/executionMode" },
        ),
      );
    }
    delete effective.account;
    delete effective.billing;
  } else if (effective.account === undefined) {
    diagnostics.push(
      createDiagnostic(
        "profile.external-account-required",
        "error",
        "External execution requires an explicit named account.",
        { pointer: joinPointer(workerPointer, "account") },
      ),
    );
  } else {
    accountPointer = pointer("accounts", effective.account);
    account = catalog.accounts?.[effective.account];
    if (account === undefined) {
      diagnostics.push(
        missingReference(
          "profile.account-not-found",
          "account",
          effective.account,
          joinPointer(workerPointer, "account"),
        ),
      );
    } else {
      if (account.engine !== effective.engine) {
        diagnostics.push(
          createDiagnostic(
            "profile.account-engine-mismatch",
            "error",
            `Account ${quotedDiagnosticValue(effective.account)} belongs to engine ${quotedDiagnosticValue(account.engine)}, not ${quotedDiagnosticValue(effective.engine)}.`,
            { pointer: joinPointer(accountPointer, "engine") },
          ),
        );
      }
      effective.billing = effective.billing ?? account.billing;
    }
  }

  const maxDurationMs =
    effective.maxDuration === undefined ? undefined : hardLimitMagnitude(effective.maxDuration);
  if (effective.maxDuration !== undefined && maxDurationMs === undefined) {
    diagnostics.push(
      createDiagnostic(
        "profile.max-duration-invalid",
        "error",
        "Resolved max_duration cannot be converted to milliseconds.",
        { pointer: joinPointer(profilePointer, "max_duration") },
      ),
    );
  }

  validateCapabilities(
    input.capabilities,
    effective,
    effective.executionMode === "external" ? effective.account : undefined,
    diagnostics,
  );

  if (hasErrors(diagnostics)) {
    return failure(diagnostics);
  }

  const provenance: ProfileProvenance[] = [];
  const addProvenance = (
    field: string,
    sourcePointer: string,
    value: JsonValue | undefined,
    overrideField?: ProfileOverrideField,
  ) => {
    if (value === undefined) {
      return;
    }
    const entry = semanticProvenance(
      base.provenance,
      field,
      sourcePointer,
      value,
      overrideField !== undefined && applied.has(overrideField),
    );
    if (entry !== undefined) {
      provenance.push(entry);
    }
  };

  addProvenance("workerId", joinPointer(profilePointer, "worker"), profile.worker);
  addProvenance("roleId", joinPointer(profilePointer, "role"), profile.role);
  addProvenance("engine", joinPointer(workerPointer, "engine"), effective.engine, "engine");
  if (effective.executionMode === "external" && effective.account !== undefined) {
    addProvenance("accountId", joinPointer(workerPointer, "account"), effective.account, "account");
    addProvenance(
      "billing",
      joinPointer(accountPointer as string, "billing"),
      effective.billing,
      "billing",
    );
  }
  addProvenance("model", joinPointer(workerPointer, "model"), effective.model, "model");
  addProvenance("effort", joinPointer(workerPointer, "effort"), effective.effort, "effort");
  addProvenance(
    "executionMode",
    joinPointer(workerPointer, "executor"),
    effective.executionMode,
    "executor",
  );
  addProvenance("questions", joinPointer(profilePointer, "questions"), profile.questions);
  addProvenance("instructionsPath", joinPointer(rolePointer, "instructions"), role.instructions);
  addProvenance(
    "artifactContract",
    joinPointer(rolePointer, "artifact_contract"),
    role.artifact_contract,
  );
  addProvenance("focus", joinPointer(profilePointer, "focus"), effective.focus, "focus");
  addProvenance(
    "maxDurationMs",
    joinPointer(profilePointer, "max_duration"),
    maxDurationMs,
    "max_duration",
  );
  addProvenance(
    "workspaceStrategy",
    joinPointer(profilePointer, "workspace_strategy"),
    effective.workspaceStrategy,
    "workspace_strategy",
  );
  provenance.sort((left, right) =>
    left.field < right.field ? -1 : left.field > right.field ? 1 : 0,
  );

  const semantics: JsonObject = {
    schemaVersion: 1,
    profileId: input.profileId,
    workerId: profile.worker,
    roleId: profile.role,
    engine: effective.engine,
    ...(effective.executionMode === "external" && effective.account !== undefined
      ? { accountId: effective.account, billing: effective.billing as "subscription" }
      : {}),
    model: effective.model,
    effort: effective.effort,
    executionMode: effective.executionMode,
    questions: profile.questions,
    instructionsPath: role.instructions,
    artifactContract: role.artifact_contract,
    ...(effective.focus !== undefined ? { focus: effective.focus } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    ...(effective.workspaceStrategy !== undefined
      ? { workspaceStrategy: effective.workspaceStrategy }
      : {}),
  };

  const resolvedProfile = {
    ...semantics,
    provenance,
    fingerprint: fingerprintFor(semantics),
  } as ResolvedProfile;

  return deepFreeze({
    ok: true,
    profile: resolvedProfile,
    diagnostics: finalizedDiagnostics(diagnostics),
  });
}
