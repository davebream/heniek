import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../src/json.js";
import type { ConfigurationLayerDocument } from "../src/layers/index.js";
import {
  type ProfileCapabilityRow,
  type ProfileInvocationOverrides,
  renderResolvedProfileSnapshot,
  resolveProfile,
} from "../src/profiles/index.js";

const CAPABILITIES: readonly ProfileCapabilityRow[] = [
  {
    engine: "claude",
    accountId: "claude-main",
    model: "opus",
    efforts: ["high", "xhigh", "ultra"],
    executionModes: ["external"],
  },
  {
    engine: "claude",
    model: "opus",
    efforts: ["high", "xhigh"],
    executionModes: ["native"],
  },
  {
    engine: "codex",
    accountId: "codex-main",
    model: "gpt-5.6-sol",
    efforts: ["high", "ultra"],
    executionModes: ["external"],
  },
  {
    engine: "cursor",
    accountId: "cursor-main",
    model: "grok-4.5",
    efforts: ["high"],
    executionModes: ["external"],
  },
];

const CATALOG: JsonObject = {
  accounts: {
    "claude-main": { engine: "claude", billing: "subscription" },
    "codex-main": { engine: "codex", billing: "subscription" },
    "cursor-main": { engine: "cursor", billing: "subscription" },
  },
  workers: {
    "claude-external": {
      engine: "claude",
      executor: "external",
      account: "claude-main",
      model: "opus",
      effort: "xhigh",
    },
    "claude-native": {
      engine: "claude",
      executor: "native",
      model: "opus",
      effort: "high",
    },
    "codex-external": {
      engine: "codex",
      executor: "external",
      account: "codex-main",
      model: "gpt-5.6-sol",
      effort: "ultra",
    },
    "cursor-external": {
      engine: "cursor",
      executor: "external",
      account: "cursor-main",
      model: "grok-4.5",
      effort: "high",
    },
  },
  roles: {
    designer: {
      instructions: "roles/designer.md",
      artifact_contract: "design.v1",
    },
  },
  profiles: {
    "claude-profile": {
      worker: "claude-external",
      role: "designer",
      questions: "parent-mediated",
      overridable: [
        "engine",
        "account",
        "billing",
        "model",
        "effort",
        "executor",
        "focus",
        "max_duration",
        "workspace_strategy",
      ],
      focus: "architecture",
      max_duration: "2h",
      workspace_strategy: "managed",
    },
    "claude-native-profile": {
      worker: "claude-native",
      role: "designer",
      questions: "parent-mediated",
    },
    "codex-profile": {
      worker: "codex-external",
      role: "designer",
      questions: "direct",
    },
    "cursor-profile": {
      worker: "cursor-external",
      role: "designer",
      questions: "direct",
    },
  },
};

function document(
  layer: ConfigurationLayerDocument["layer"],
  values: JsonObject,
  sourcePath = `/${layer}.yaml`,
): ConfigurationLayerDocument {
  return { layer, values, sourcePath };
}

function resolve(
  profileId = "claude-profile",
  options: {
    readonly documents?: readonly ConfigurationLayerDocument[];
    readonly overrides?: ProfileInvocationOverrides;
    readonly capabilities?: readonly ProfileCapabilityRow[];
  } = {},
) {
  return resolveProfile({
    profileId,
    documents: options.documents ?? [document("global-defaults", CATALOG)],
    capabilities: options.capabilities ?? CAPABILITIES,
    ...(options.overrides !== undefined ? { invocationOverrides: options.overrides } : {}),
  });
}

function errorCodes(result: ReturnType<typeof resolveProfile>): readonly string[] {
  return result.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.code);
}

describe("profile resolution", () => {
  it("composes a provider-neutral external profile with source provenance and a fingerprint", () => {
    const result = resolve();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toMatchObject({
      schemaVersion: 1,
      profileId: "claude-profile",
      workerId: "claude-external",
      roleId: "designer",
      engine: "claude",
      accountId: "claude-main",
      billing: "subscription",
      model: "opus",
      effort: "xhigh",
      executionMode: "external",
      questions: "parent-mediated",
      instructionsPath: "roles/designer.md",
      artifactContract: "design.v1",
      focus: "architecture",
      maxDurationMs: 7_200_000,
      workspaceStrategy: "managed",
    });
    expect(result.profile.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.profile.provenance.find((entry) => entry.field === "effort")).toMatchObject({
      pointer: "/workers/claude-external/effort",
      layer: "global-defaults",
      sourcePath: "/global-defaults.yaml",
      value: "xhigh",
    });
    expect(JSON.parse(renderResolvedProfileSnapshot(result.profile))).toEqual(result.profile);
  });

  it("applies all seven layers and records the full override chain", () => {
    const effortLayers = [
      ["built-in-defaults", "high"],
      ["global-defaults", "xhigh"],
      ["codebase", "high"],
      ["repository", "xhigh"],
      ["pipeline-template", "high"],
      ["profile-or-stage", "xhigh"],
    ] as const;
    const baseWithoutEffort = structuredClone(CATALOG) as Record<string, JsonObject>;
    delete ((baseWithoutEffort.workers as JsonObject)["claude-external"] as Record<string, unknown>)
      .effort;
    const documents: ConfigurationLayerDocument[] = [
      document("built-in-defaults", baseWithoutEffort),
      ...effortLayers.map(([layer, effort]) =>
        document(layer, { workers: { "claude-external": { effort } } }, `/${layer}.yaml`),
      ),
    ];

    const result = resolve("claude-profile", {
      documents,
      overrides: { effort: "ultra" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.effort).toBe("ultra");
    expect(result.profile.provenance.find((entry) => entry.field === "effort")).toEqual({
      field: "effort",
      pointer: "/workers/claude-external/effort",
      layer: "invocation-override",
      value: "ultra",
      overridden: effortLayers.map(([layer, effort]) => ({
        layer,
        sourcePath: `/${layer}.yaml`,
        value: effort,
      })),
    });
  });

  it("validates dependent fields after applying a permitted multi-field override", () => {
    const result = resolve("claude-profile", {
      overrides: {
        engine: "codex",
        account: "codex-main",
        billing: "subscription",
        model: "gpt-5.6-sol",
        effort: "high",
        executor: "external",
        focus: "security",
        max_duration: "45m",
        workspace_strategy: "existing",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toMatchObject({
      engine: "codex",
      accountId: "codex-main",
      billing: "subscription",
      model: "gpt-5.6-sol",
      effort: "high",
      executionMode: "external",
      focus: "security",
      maxDurationMs: 2_700_000,
      workspaceStrategy: "existing",
    });
    expect(
      result.profile.provenance
        .filter((entry) => entry.layer === "invocation-override")
        .map((entry) => entry.field),
    ).toEqual([
      "accountId",
      "billing",
      "effort",
      "engine",
      "executionMode",
      "focus",
      "maxDurationMs",
      "model",
      "workspaceStrategy",
    ]);
  });

  it("preserves caller order for definitions in the same layer", () => {
    const result = resolve("claude-profile", {
      documents: [
        document("global-defaults", CATALOG, "/base.yaml"),
        document(
          "profile-or-stage",
          { workers: { "claude-external": { effort: "high" } } },
          "/first.yaml",
        ),
        document(
          "profile-or-stage",
          { workers: { "claude-external": { effort: "ultra" } } },
          "/second.yaml",
        ),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.effort).toBe("ultra");
    expect(result.profile.provenance.find((entry) => entry.field === "effort")?.sourcePath).toBe(
      "/second.yaml",
    );
  });

  it("rejects blocked, unknown, malformed, and raw-document overrides", () => {
    const restrictedCatalog = {
      ...CATALOG,
      profiles: {
        ...(CATALOG.profiles as JsonObject),
        "claude-profile": {
          ...((CATALOG.profiles as JsonObject)["claude-profile"] as JsonObject),
          overridable: ["focus"],
        },
      },
    } satisfies JsonObject;
    const overrides = {
      effort: "high",
      focus: "",
      unsupported: "value",
    } as unknown as ProfileInvocationOverrides;
    const result = resolve("claude-profile", {
      documents: [
        document("global-defaults", restrictedCatalog),
        document("invocation-override", { workers: {} }, "/raw-override.yaml"),
      ],
      overrides,
    });

    expect(errorCodes(result)).toEqual(
      expect.arrayContaining([
        "profile.invocation-document-forbidden",
        "profile.override-invalid",
        "profile.override-not-permitted",
        "profile.override-unknown",
      ]),
    );
    expect(result).not.toHaveProperty("profile");
  });

  it.each([
    ["claude-profile", "claude", "external", "xhigh"],
    ["claude-native-profile", "claude", "native", "high"],
    ["codex-profile", "codex", "external", "ultra"],
    ["cursor-profile", "cursor", "external", "high"],
  ] as const)(
    "validates %s through the injected cross-engine table",
    (profileId, engine, executionMode, effort) => {
      const result = resolve(profileId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.profile).toMatchObject({ engine, executionMode, effort });
    },
  );

  it.each([
    ["unknown model", { model: "unknown-model" }, "profile.capability-not-found"],
    ["unsupported effort", { effort: "impossible" }, "profile.effort-unsupported"],
  ] as const)("fails closed for %s", (_name, overrides, code) => {
    const result = resolve("claude-profile", { overrides });
    expect(errorCodes(result)).toContain(code);
    expect(result).not.toHaveProperty("profile");
  });

  it("reports unsupported execution mode independently of native account policy", () => {
    const catalog = structuredClone(CATALOG) as Record<string, JsonObject>;
    const worker = (catalog.workers as JsonObject)["codex-external"] as Record<string, unknown>;
    worker.executor = "native";
    delete worker.account;
    const result = resolve("codex-profile", {
      documents: [document("global-defaults", catalog)],
      capabilities: [
        ...CAPABILITIES,
        {
          engine: "codex",
          model: "gpt-5.6-sol",
          efforts: ["ultra"],
          executionModes: ["external"],
        },
      ],
    });
    expect(errorCodes(result)).toEqual(
      expect.arrayContaining([
        "profile.native-engine-invalid",
        "profile.execution-mode-unsupported",
      ]),
    );
  });

  it.each([
    [
      "missing worker",
      { profiles: { broken: { worker: "missing", role: "designer", questions: "direct" } } },
      "broken",
      "profile.worker-not-found",
    ],
    [
      "missing role",
      {
        profiles: {
          broken: { worker: "claude-external", role: "missing", questions: "direct" },
        },
      },
      "broken",
      "profile.role-not-found",
    ],
  ] as const)("reports %s", (_name, values, profileId, code) => {
    const result = resolve(profileId, {
      documents: [document("global-defaults", CATALOG), document("profile-or-stage", values)],
    });
    expect(errorCodes(result)).toContain(code);
  });

  it("rejects missing external accounts and engine/account mismatches", () => {
    const withoutAccount = structuredClone(CATALOG) as Record<string, JsonObject>;
    delete ((withoutAccount.workers as JsonObject)["claude-external"] as Record<string, unknown>)
      .account;
    const missing = resolve("claude-profile", {
      documents: [document("global-defaults", withoutAccount)],
    });
    expect(errorCodes(missing)).toContain("profile.external-account-required");

    const mismatched = resolve("claude-profile", {
      overrides: { account: "codex-main" },
      capabilities: [
        ...CAPABILITIES,
        {
          engine: "claude",
          accountId: "codex-main",
          model: "opus",
          efforts: ["xhigh"],
          executionModes: ["external"],
        },
      ],
    });
    expect(errorCodes(mismatched)).toContain("profile.account-engine-mismatch");
  });

  it("rejects accounts on declared native workers and unsafe role instruction paths", () => {
    const nativeWithAccount = structuredClone(CATALOG) as Record<string, JsonObject>;
    (
      (nativeWithAccount.workers as JsonObject)["claude-native"] as Record<string, unknown>
    ).account = "claude-main";
    expect(
      errorCodes(
        resolve("claude-native-profile", {
          documents: [document("global-defaults", nativeWithAccount)],
        }),
      ),
    ).toContain("profile.native-account-forbidden");

    expect(errorCodes(resolve("claude-profile", { overrides: { executor: "native" } }))).toContain(
      "profile.native-account-forbidden",
    );

    const unsafeRole = structuredClone(CATALOG) as Record<string, JsonObject>;
    for (const instructions of ["../outside.md", "roles/..\\outside.md", "C:\\outside.md"]) {
      ((unsafeRole.roles as JsonObject).designer as Record<string, unknown>).instructions =
        instructions;
      expect(
        errorCodes(
          resolve("claude-profile", {
            documents: [document("global-defaults", unsafeRole)],
          }),
        ),
      ).toContain("profile.configuration-invalid");
    }
  });

  it("keeps fingerprints stable across source paths and key order, but changes on semantics", () => {
    const first = resolve("claude-profile", {
      documents: [document("global-defaults", CATALOG, "/first/location.yaml")],
    });
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .reverse()
          .map(([key, child]) => [key, reverseKeys(child)]),
      );
    };
    const reordered = reverseKeys(CATALOG) as JsonObject;
    const second = resolve("claude-profile", {
      documents: [document("global-defaults", reordered, "/other/location.yaml")],
    });
    const changed = resolve("claude-profile", { overrides: { effort: "high" } });

    expect(first.ok && second.ok && first.profile.fingerprint).toBe(
      second.ok ? second.profile.fingerprint : undefined,
    );
    expect(first.ok && changed.ok && first.profile.fingerprint).not.toBe(
      changed.ok ? changed.profile.fingerprint : undefined,
    );
  });

  it("rejects credential-shaped invocation values without echoing them", () => {
    const tokenShapedValue = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8".slice(0, 36)}`;
    const overrideResult = resolve("claude-profile", {
      overrides: { focus: tokenShapedValue },
    });

    expect(errorCodes(overrideResult)).toContain("profile.override-sensitive-value");
    expect(JSON.stringify(overrideResult)).not.toContain(tokenShapedValue);

    const diagnosticCatalog = structuredClone(CATALOG) as Record<string, JsonObject>;
    (
      (diagnosticCatalog.workers as JsonObject)["claude-external"] as Record<string, unknown>
    ).model = tokenShapedValue;
    const diagnosticResult = resolve("claude-profile", {
      documents: [document("global-defaults", diagnosticCatalog)],
    });
    expect(errorCodes(diagnosticResult)).toContain("profile.capability-not-found");
    expect(JSON.stringify(diagnosticResult)).not.toContain(tokenShapedValue);

    const snapshotCatalog = structuredClone(CATALOG) as Record<string, JsonObject>;
    ((snapshotCatalog.profiles as JsonObject)["claude-profile"] as Record<string, unknown>).focus =
      tokenShapedValue;
    const snapshotResult = resolve("claude-profile", {
      documents: [document("global-defaults", snapshotCatalog)],
    });

    expect(snapshotResult.ok).toBe(true);
    if (!snapshotResult.ok) return;
    expect(snapshotResult.profile.focus).toBe(tokenShapedValue);
    expect(renderResolvedProfileSnapshot(snapshotResult.profile)).not.toContain(tokenShapedValue);
  });

  it("deep-freezes successful and failed results", () => {
    const result = resolve();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.profile)).toBe(true);
    expect(Object.isFrozen(result.profile.provenance)).toBe(true);

    const failed = resolve("claude-profile", { overrides: { effort: "unsupported" } });
    expect(failed.ok).toBe(false);
    expect(Object.isFrozen(failed)).toBe(true);
    expect(Object.isFrozen(failed.diagnostics)).toBe(true);
  });

  it("cannot reach a workspace-mutating continuation after invalid resolution", () => {
    const mutateWorkspace = vi.fn();
    const result = resolve("claude-profile", { overrides: { effort: "unsupported" } });
    if (result.ok) {
      mutateWorkspace(result.profile);
    }
    expect(result.ok).toBe(false);
    expect(mutateWorkspace).not.toHaveBeenCalled();
  });
});
