import {
  CLAUDEXOR_PROTOCOL_MAJOR,
  type ClaudexorEngineIdentity,
  claudexorHeaders,
  parseHandshake,
} from "@heniek/execution-claudexor";
import { CAPABILITY_FRESHNESS_MILLISECONDS } from "./service.js";
import type {
  CapabilityDiscoverySource,
  CapabilityEngine,
  CapabilityEntry,
  ConfiguredCapabilityAccount,
} from "./types.js";

type JsonRecord = Record<string, unknown>;
type EvidenceSource = CapabilityEntry["provenance"][number]["source"];

const PINNED_COMPATIBILITY: Record<
  CapabilityEngine,
  {
    readonly state: "compatible";
    readonly resume: "supported" | "unknown";
    readonly cancellation: "supported" | "unknown";
  }
> = {
  claude: { state: "compatible", resume: "supported", cancellation: "supported" },
  codex: { state: "compatible", resume: "supported", cancellation: "supported" },
  // Q018 spike, against Cursor CLI 2026.06.12-01-15-52-7244546 and the pinned
  // Claudexor: `--resume <sessionId>` continues the SAME session rather than
  // forking one, and cancellation terminates the run. Cursor's own detached
  // `worker-server` process outlives a cancelled run by design; that is a
  // process-cleanup caveat recorded in the ADR, not a cancellation failure.
  cursor: { state: "compatible", resume: "supported", cancellation: "supported" },
};

export interface ClaudexorCapabilityAdapterOptions {
  readonly baseUrl: string;
  readonly expectedEngine: ClaudexorEngineIdentity;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMilliseconds?: number;
  readonly clock?: { now(): Date };
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is JsonRecord => item !== undefined)
    : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((item): item is string => typeof item === "string" && item.length > 0),
        ),
      ]
    : [];
}

function effortLevels(value: unknown): string[] {
  const direct = strings(value);
  if (direct.length > 0) return direct;
  return strings(first(record(value), "levels"));
}

function first(object: JsonRecord | undefined, ...names: string[]): unknown {
  for (const name of names) if (object?.[name] !== undefined) return object[name];
  return undefined;
}

function engineId(value: unknown): CapabilityEngine | undefined {
  const id = string(value)?.toLowerCase();
  if (id === "claude" || id === "codex" || id === "cursor") return id;
  return undefined;
}

function discoveryTargets(accounts: readonly ConfiguredCapabilityAccount[]) {
  const targets: Array<{
    engine: CapabilityEngine;
    accountId: string | null;
    configured: boolean;
  }> = [];
  for (const engine of ["claude", "codex", "cursor"] as const) {
    const matching = accounts.filter((account) => account.engine === engine);
    if (engine === "claude") targets.push({ engine, accountId: null, configured: true });
    if (matching.length === 0 && engine !== "claude")
      targets.push({ engine, accountId: null, configured: false });
    for (const account of matching)
      targets.push({ engine, accountId: account.accountId, configured: true });
  }
  return targets;
}

function state(
  support: "supported" | "unsupported" | "unknown",
  source: EvidenceSource,
  observedAt: string,
  reasons: string[] = [],
): CapabilityEntry["features"]["resume"] {
  return { support, evidence: [{ source, observedAt }], reasons };
}

function advertised(
  object: JsonRecord | undefined,
  keys: readonly string[],
): "supported" | "unsupported" | "unknown" {
  for (const key of keys) {
    const value = object?.[key];
    if (value === true) return "supported";
    if (value === false) return "unsupported";
  }
  return "unknown";
}

async function json(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text.length === 0 ? null : JSON.parse(text);
  } catch {
    throw new Error("Claudexor returned malformed JSON.");
  }
}

export function createClaudexorCapabilityAdapter(
  options: ClaudexorCapabilityAdapterOptions,
): CapabilityDiscoverySource {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const timeout = options.timeoutMilliseconds ?? 30_000;
  const clock = options.clock ?? { now: () => new Date() };

  async function get(path: string): Promise<unknown> {
    const response = await request(`${baseUrl}${path}`, {
      headers: claudexorHeaders(options.token),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`Claudexor ${path} failed with HTTP ${response.status}.`);
    return json(response);
  }

  async function post(path: string, body: unknown): Promise<unknown> {
    const response = await request(`${baseUrl}${path}`, {
      method: "POST",
      headers: claudexorHeaders(options.token),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`Claudexor ${path} failed with HTTP ${response.status}.`);
    return json(response);
  }

  return {
    async inspectVersions(accounts) {
      parseHandshake(
        await post("/v2/handshake", {
          protocolMajor: CLAUDEXOR_PROTOCOL_MAJOR,
          client: "heniek-q015-version-probe",
        }),
        options.expectedEngine,
      );
      const harnessBody = record(await get("/v2/harnesses"));
      const harnessCollection = first(harnessBody, "harnesses", "items", "data");
      if (!Array.isArray(harnessCollection)) {
        throw new Error("Claudexor harness inventory is malformed.");
      }
      const harnesses = records(harnessCollection);
      return discoveryTargets(accounts).map(({ engine, accountId }) => {
        const harness = harnesses.find(
          (item) => engineId(first(item, "id", "harnessId", "harness_id")) === engine,
        );
        const manifest = record(first(harness, "manifest"));
        return {
          engine,
          accountId,
          engineVersion: string(first(manifest, "version")) ?? null,
          claudexorVersion: options.expectedEngine.version,
        };
      });
    },
    async discover(accounts) {
      parseHandshake(
        await post("/v2/handshake", {
          protocolMajor: CLAUDEXOR_PROTOCOL_MAJOR,
          client: "heniek-q015",
        }),
        options.expectedEngine,
      );
      const operationsBody = record(await get("/v2/operations"));
      const operations = new Set(
        records(first(operationsBody, "operations")).flatMap((operation) => {
          const method = string(first(operation, "method"));
          const path = string(first(operation, "path"));
          return method === undefined || path === undefined
            ? []
            : [`${method.toUpperCase()} ${path}`];
        }),
      );
      const requiredOperations = [
        "GET /v2/agent-capabilities",
        "GET /v2/credential-profiles",
        "GET /v2/harnesses",
        "GET /v2/harnesses/:id/models",
        "POST /v2/harnesses/:id/auth-readiness",
        "GET /v2/quota",
      ];
      const missingOperations = requiredOperations.filter(
        (operation) => !operations.has(operation),
      );
      if (missingOperations.length > 0) {
        throw new Error(
          `Pinned Claudexor operation catalogue is missing ${missingOperations.join(", ")}.`,
        );
      }
      const now = clock.now();
      const observedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + CAPABILITY_FRESHNESS_MILLISECONDS).toISOString();
      const [harnessResult, credentialResult, capabilityResult, quotaResult] =
        await Promise.allSettled([
          get("/v2/harnesses"),
          get("/v2/credential-profiles"),
          get("/v2/agent-capabilities"),
          get("/v2/quota"),
        ]);
      if (harnessResult.status === "rejected") throw harnessResult.reason;

      const harnessBody = record(harnessResult.value);
      const harnessCollection = first(harnessBody, "harnesses", "items", "data");
      if (!Array.isArray(harnessCollection)) {
        throw new Error("Claudexor harness inventory is malformed.");
      }
      const harnesses = records(harnessCollection);
      const credentialBody =
        credentialResult.status === "fulfilled" ? record(credentialResult.value) : undefined;
      const profileCollection = first(credentialBody, "profiles", "credentialProfiles");
      const harnessAccountCollection = first(credentialBody, "harnessAccounts", "harness_accounts");
      const credentialMalformed =
        credentialResult.status === "fulfilled" &&
        (!Array.isArray(profileCollection) || !Array.isArray(harnessAccountCollection));
      const profiles = records(profileCollection);
      const harnessAccounts = records(harnessAccountCollection);
      const quotaBody = quotaResult.status === "fulfilled" ? record(quotaResult.value) : undefined;
      const snapshotCollection = first(quotaBody, "snapshots", "items");
      const absenceCollection = first(quotaBody, "absences");
      const quotaMalformed =
        quotaResult.status === "fulfilled" &&
        (!Array.isArray(snapshotCollection) ||
          (absenceCollection !== undefined && !Array.isArray(absenceCollection)));
      const snapshots = records(snapshotCollection);
      const absences = records(absenceCollection);
      const capabilityBody =
        capabilityResult.status === "fulfilled" ? record(capabilityResult.value) : undefined;
      const capabilityCollection = first(capabilityBody, "harnesses", "capabilities", "items");
      const capabilityMalformed =
        capabilityResult.status === "fulfilled" && !Array.isArray(capabilityCollection);
      const capabilityRows = records(capabilityCollection);
      const claudexorVersion =
        string(first(capabilityBody, "version")) ?? options.expectedEngine.version;

      const targets = discoveryTargets(accounts);

      return Promise.all(
        targets.map(async (target): Promise<CapabilityEntry> => {
          const harness = harnesses.find(
            (item) => engineId(first(item, "id", "harnessId", "harness_id")) === target.engine,
          );
          const manifest = record(first(harness, "manifest"));
          const capabilities =
            record(first(manifest, "capabilities")) ?? record(first(harness, "capabilities"));
          const summary = capabilityRows.find(
            (item) => engineId(first(item, "id", "harnessId", "harness_id")) === target.engine,
          );
          const profileRow =
            target.accountId === null
              ? undefined
              : profiles.find((item) => {
                  const profile = record(first(item, "profile")) ?? item;
                  return (
                    string(first(profile, "profile_id", "profileId")) === target.accountId &&
                    engineId(first(profile, "harness_id", "harnessId")) === target.engine
                  );
                });
          const profile = record(first(profileRow, "profile")) ?? profileRow;
          const native = harnessAccounts.find(
            (item) => engineId(first(item, "harness_id", "harnessId")) === target.engine,
          );
          // Codex and Cursor both authenticate through a Claudexor-owned native
          // session rather than a named credential profile, so their readiness
          // is probed for every configured account, not only account-less ones.
          const nativeSessionRoute =
            (target.engine === "claude" && target.accountId === null) ||
            target.engine === "codex" ||
            target.engine === "cursor";
          const readinessResult =
            target.configured && nativeSessionRoute
              ? await Promise.allSettled([
                  post(`/v2/harnesses/${encodeURIComponent(target.engine)}/auth-readiness`, {
                    authRequest: "subscription",
                    source: "native_session",
                  }),
                ])
              : [];
          const readiness =
            readinessResult[0]?.status === "fulfilled"
              ? record(readinessResult[0].value)
              : undefined;
          const readinessState = record(first(readiness, "readiness"));
          const checks = records(first(harness, "checks"));
          const installedCheck = checks.find((check) => string(first(check, "id")) === "installed");
          const compatibilityCheck = checks.find((check) => {
            const id = string(first(check, "id"))?.toLowerCase();
            return id?.includes("compatib") === true || id?.includes("version") === true;
          });
          const installed =
            harness === undefined
              ? "not-installed"
              : string(first(installedCheck, "status")) === "fail"
                ? "not-installed"
                : string(first(installedCheck, "status")) === "pass" ||
                    string(first(manifest, "version")) !== undefined
                  ? "installed"
                  : "unknown";
          const profileStatus = record(first(profileRow, "status"));
          const authEvidence = readinessState ?? profileStatus;
          const authAvailability = string(first(authEvidence, "availability"));
          const authVerification = string(first(authEvidence, "verification"));
          const nativeLogin =
            first(native, "native_login_detected", "nativeLoginDetected") === true &&
            first(native, "native_credentials_enabled", "nativeCredentialsEnabled") !== false;
          const authentication =
            (authAvailability === "available" && authVerification === "passed") ||
            (target.accountId === null && target.engine === "claude" && nativeLogin)
              ? "authenticated"
              : authAvailability === "unavailable" ||
                  authVerification === "failed" ||
                  (profile === undefined && target.accountId !== null)
                ? "unauthenticated"
                : "unknown";
          const compatible =
            harness === undefined
              ? "unknown"
              : string(first(compatibilityCheck, "status")) === "fail"
                ? "incompatible"
                : PINNED_COMPATIBILITY[target.engine].state;
          const quota = snapshots.find((item) => {
            const subject = record(first(item, "subject"));
            const subjectHarness = engineId(first(subject, "harness"));
            const subjectId = string(first(subject, "subject_id", "subjectId"));
            return (
              subjectHarness === target.engine &&
              (target.accountId === null || subjectId === target.accountId)
            );
          });
          const quotaAbsence = absences.find((item) => {
            const subject = record(first(item, "subject"));
            return (
              engineId(first(subject, "harness")) === target.engine &&
              (target.accountId === null ||
                string(first(subject, "subject_id", "subjectId")) === target.accountId)
            );
          });
          const quotaAbsenceReason = string(first(quotaAbsence, "reason"));
          const constraints = records(first(quota, "constraints"));
          const limited = constraints.some((constraint) => {
            const cooldown = string(first(constraint, "cooldown_until", "cooldownUntil"));
            const used = first(constraint, "used_ratio", "usedRatio");
            return (
              (cooldown !== undefined && Date.parse(cooldown) > now.getTime()) ||
              (typeof used === "number" && used >= 1)
            );
          });
          const capacity = quota === undefined ? "unknown" : limited ? "rate-limited" : "available";
          const modelResult =
            harness === undefined
              ? undefined
              : await get(`/v2/harnesses/${encodeURIComponent(target.engine)}/models`).catch(
                  () => undefined,
                );
          const modelBody = record(modelResult);
          const modelMalformed =
            modelResult !== undefined && !Array.isArray(first(modelBody, "models"));
          const modelSource = string(first(modelBody, "source"));
          const defaultEfforts = strings(first(capabilities, "effort_levels", "effortLevels"));
          const perModelEfforts = record(
            first(capabilities, "model_effort_levels", "modelEffortLevels"),
          );
          const modes =
            target.engine === "claude" && target.accountId === null
              ? (["native"] as const)
              : (["external"] as const);
          const models: CapabilityEntry["models"] = records(first(modelBody, "models")).flatMap(
            (model) => {
              const id = string(first(model, "id"));
              if (id === undefined) return [];
              const label = string(first(model, "label"));
              const provenance: "api" | "manifest" | "none" =
                modelSource === "api" ? "api" : modelSource === "manifest" ? "manifest" : "none";
              return [
                {
                  id,
                  ...(label === undefined ? {} : { label }),
                  provenance,
                  efforts:
                    effortLevels(perModelEfforts?.[id]).length > 0
                      ? effortLevels(perModelEfforts?.[id])
                      : defaultEfforts,
                  executionModes: [...modes],
                },
              ];
            },
          );
          const capabilityProfile =
            record(first(manifest, "capability_profile", "capabilityProfile")) ?? {};
          const toolCapabilities = [
            {
              name: "read-files",
              support: advertised(capabilities, ["read_files", "readFiles"]),
            },
            {
              name: "browser",
              support: advertised(capabilities, ["browser_tool", "browserTool"]),
            },
            {
              name: "tool-lists",
              support: advertised(capabilities, ["tool_lists", "toolLists"]),
            },
            {
              name: "mcp-injection",
              support: advertised(capabilityProfile, ["mcp_injection", "mcpInjection"]),
            },
          ] as const;
          const compatibility = PINNED_COMPATIBILITY[target.engine];
          const endpointFailures =
            [credentialResult, capabilityResult, quotaResult].filter(
              (result) => result.status === "rejected",
            ).length +
            [credentialMalformed, capabilityMalformed, quotaMalformed, modelMalformed].filter(
              Boolean,
            ).length +
            (modelResult === undefined && harness !== undefined ? 1 : 0) +
            (readinessResult[0]?.status === "rejected" ? 1 : 0);
          const sectionReasons = [
            ...(credentialResult.status === "rejected" || credentialMalformed
              ? ["capability.account-profiles-unavailable"]
              : []),
            ...(capabilityResult.status === "rejected" || capabilityMalformed
              ? ["capability.advertisement-unavailable"]
              : []),
            ...(quotaResult.status === "rejected" || quotaMalformed
              ? ["capability.quota-unavailable"]
              : []),
            ...(modelResult === undefined && harness !== undefined
              ? ["capability.models-unavailable"]
              : []),
            ...(modelMalformed ? ["capability.models-malformed"] : []),
            ...(readinessResult[0]?.status === "rejected"
              ? ["capability.auth-readiness-unavailable"]
              : []),
            ...(quotaAbsenceReason === undefined
              ? []
              : [`capability.quota-absent:${quotaAbsenceReason}`]),
          ];
          const reasons = [
            ...(target.configured ? [] : ["capability.account-unconfigured"]),
            ...(installed === "installed" ? [] : ["capability.binary-missing"]),
            ...(authentication === "authenticated"
              ? []
              : [
                  authentication === "unknown"
                    ? "capability.authentication-unknown"
                    : "capability.unauthenticated",
                ]),
            ...(compatible === "compatible"
              ? []
              : [
                  compatible === "unknown"
                    ? "capability.compatibility-unknown"
                    : "capability.incompatible",
                ]),
            ...(limited ? ["capability.rate-limited"] : []),
            ...sectionReasons,
            ...(endpointFailures > 0 ? ["capability.discovery-partial"] : []),
          ];
          const ready =
            target.configured &&
            installed === "installed" &&
            authentication === "authenticated" &&
            compatible === "compatible" &&
            capacity !== "rate-limited";
          return {
            engine: target.engine,
            accountId: target.accountId,
            engineVersion: string(first(manifest, "version")) ?? null,
            claudexorVersion,
            observedAt,
            expiresAt,
            freshness: "fresh",
            discovery: endpointFailures === 0 ? "complete" : "partial",
            configured: target.configured,
            installation: installed,
            authentication,
            compatibility: compatible,
            capacity,
            ready,
            models,
            features: {
              questions: state(
                advertised(capabilities, ["interactive"]),
                "harness-inventory",
                observedAt,
                advertised(capabilities, ["interactive"]) === "unknown"
                  ? ["capability.questions-unknown"]
                  : [],
              ),
              resume: state(
                compatibility.resume,
                "compatibility-attestation",
                observedAt,
                compatibility.resume === "unknown" ? ["capability.resume-unknown"] : [],
              ),
              usage: state(
                quota === undefined ? "unknown" : "supported",
                "quota",
                observedAt,
                quota === undefined
                  ? [
                      quotaAbsenceReason === undefined
                        ? "capability.usage-unknown"
                        : `capability.quota-absent:${quotaAbsenceReason}`,
                    ]
                  : [],
              ),
              structuredOutput: state(
                advertised(capabilities, ["json_schema_output", "jsonSchemaOutput"]),
                "harness-inventory",
                observedAt,
                advertised(capabilities, ["json_schema_output", "jsonSchemaOutput"]) === "unknown"
                  ? ["capability.structured-output-unknown"]
                  : [],
              ),
              cancellation: state(
                compatibility.cancellation,
                "compatibility-attestation",
                observedAt,
                compatibility.cancellation === "unknown" ? ["capability.cancellation-unknown"] : [],
              ),
              tools: toolCapabilities.map(({ name, support }) => ({
                name,
                state: state(support, "harness-inventory", observedAt),
              })),
            },
            provenance: [
              { source: "harness-inventory", observedAt },
              ...(summary === undefined
                ? []
                : [{ source: "agent-capabilities" as const, observedAt }]),
              ...(profile === undefined
                ? []
                : [{ source: "account-profile" as const, observedAt }]),
              ...(readiness === undefined
                ? []
                : [{ source: "auth-readiness" as const, observedAt }]),
              ...(quota === undefined ? [] : [{ source: "quota" as const, observedAt }]),
              ...(compatibility.resume === "supported" || compatibility.cancellation === "supported"
                ? [{ source: "compatibility-attestation" as const, observedAt }]
                : []),
              ...(modelSource === "api"
                ? [{ source: "model-api" as const, observedAt }]
                : modelSource === "manifest"
                  ? [{ source: "model-manifest" as const, observedAt }]
                  : []),
            ],
            reasons: [...new Set(reasons)],
          };
        }),
      );
    },
  };
}
