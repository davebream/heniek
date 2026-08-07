import type { ProfileCapabilityRow } from "@heniek/config";
import type {
  CapabilityCatalogue,
  CapabilityClock,
  CapabilityDiscoverySource,
  CapabilityEntry,
  CapabilityRequirement,
  CapabilitySelectionError,
  CapabilitySnapshotStore,
  ConfiguredCapabilityAccount,
} from "./types.js";

export const CAPABILITY_FRESHNESS_MILLISECONDS = 120_000;
const ENGINES = ["claude", "codex", "cursor"] as const;

function targets(accounts: readonly ConfiguredCapabilityAccount[]) {
  const result: Array<{ engine: (typeof ENGINES)[number]; accountId: string | null }> = [];
  for (const engine of ENGINES) {
    const matching = accounts.filter((account) => account.engine === engine);
    if (engine === "claude") result.push({ engine, accountId: null });
    if (matching.length === 0 && engine !== "claude") result.push({ engine, accountId: null });
    for (const account of matching) result.push({ engine, accountId: account.accountId });
  }
  return result;
}

function stale(entry: CapabilityEntry, observedAt: string): CapabilityEntry {
  return {
    ...entry,
    freshness: "stale",
    discovery: "failed",
    ready: false,
    provenance: [
      ...entry.provenance,
      { source: "cache", observedAt, detail: "Discovery refresh failed; retained prior snapshot." },
    ],
    reasons: [...new Set([...entry.reasons, "capability.snapshot-stale"])],
  };
}

export interface CapabilityService {
  catalogue(request?: { readonly refresh?: boolean }): Promise<CapabilityCatalogue>;
}

export function createCapabilityService(options: {
  readonly accounts: readonly ConfiguredCapabilityAccount[];
  readonly source: CapabilityDiscoverySource;
  readonly store: CapabilitySnapshotStore;
  readonly clock: CapabilityClock;
}): CapabilityService {
  return {
    async catalogue(request = {}) {
      const generatedAt = options.clock.now().toISOString();
      const expected = targets(options.accounts);
      const cached = expected.map(({ engine, accountId }) =>
        options.store.readLatest(engine, accountId),
      );
      const allFresh = cached.every(
        (entry) => entry !== undefined && Date.parse(entry.expiresAt) > Date.parse(generatedAt),
      );
      let cacheVersionCompatible: boolean | undefined;
      if (cached.every((entry) => entry !== undefined) && options.source.inspectVersions) {
        try {
          const versions = await options.source.inspectVersions(options.accounts);
          cacheVersionCompatible = expected.every(({ engine, accountId }, index) => {
            const current = versions.find(
              (version) => version.engine === engine && version.accountId === accountId,
            );
            const entry = cached[index];
            return (
              entry !== undefined &&
              current !== undefined &&
              entry.engineVersion === current.engineVersion &&
              entry.claudexorVersion === current.claudexorVersion
            );
          });
        } catch {
          cacheVersionCompatible = undefined;
        }
      }
      if (!request.refresh && allFresh && cacheVersionCompatible !== false) {
        return { schemaVersion: 1, generatedAt, entries: cached as CapabilityEntry[] };
      }

      try {
        const discovered = await options.source.discover(options.accounts);
        for (const entry of discovered) options.store.write(entry);
        return { schemaVersion: 1, generatedAt, entries: discovered };
      } catch {
        const fallback = cached.filter((entry): entry is CapabilityEntry => entry !== undefined);
        if (fallback.length === expected.length && cacheVersionCompatible !== false) {
          return {
            schemaVersion: 1,
            generatedAt,
            entries: fallback.map((entry) => stale(entry, generatedAt)),
          };
        }
        throw new Error(
          "Capability discovery failed and no complete cached catalogue is available.",
        );
      }
    },
  };
}

export function profileCapabilityRows(catalogue: CapabilityCatalogue): ProfileCapabilityRow[] {
  return catalogue.entries.flatMap((entry) =>
    entry.models.map((model) => ({
      engine: entry.engine,
      ...(entry.accountId === null ? {} : { accountId: entry.accountId }),
      model: model.id,
      efforts: model.efforts,
      executionModes: model.executionModes,
    })),
  );
}

function issue(
  capability: string,
  state: CapabilitySelectionError["issues"][number]["state"],
  message: string,
) {
  return { capability, state, message };
}

export function validateCapabilitySelection(
  catalogue: CapabilityCatalogue,
  requirement: CapabilityRequirement,
  phase: "authoring" | "execution",
):
  | { readonly ok: true; readonly warnings: readonly string[] }
  | {
      readonly ok: false;
      readonly error: CapabilitySelectionError;
    } {
  const accountId = requirement.executionMode === "native" ? null : (requirement.accountId ?? null);
  const entry = catalogue.entries.find(
    (candidate) => candidate.engine === requirement.engine && candidate.accountId === accountId,
  );
  const issues: CapabilitySelectionError["issues"] = [];
  const warnings: string[] = [];
  if (entry === undefined) {
    issues.push(
      issue(
        "catalogue-entry",
        "missing",
        "No capability evidence exists for the selected engine and account.",
      ),
    );
  } else {
    if (!entry.configured) {
      issues.push(
        issue("configuration", "missing", "The selected engine account is not configured."),
      );
    }
    if (entry.freshness === "stale") {
      if (phase === "execution")
        issues.push(issue("freshness", "stale", "Execution requires fresh capability evidence."));
      else warnings.push("Authoring validation used stale capability evidence.");
    }
    if (entry.installation !== "installed") {
      issues.push(
        issue(
          "installation",
          entry.installation === "unknown" ? "unknown" : "missing",
          "The selected engine is not known to be installed.",
        ),
      );
    }
    if (entry.authentication !== "authenticated") {
      issues.push(
        issue(
          "authentication",
          entry.authentication === "unknown" ? "unknown" : "unauthenticated",
          "The selected account is not authenticated.",
        ),
      );
    }
    if (entry.compatibility !== "compatible") {
      issues.push(
        issue(
          "compatibility",
          entry.compatibility === "unknown" ? "unknown" : "incompatible",
          "The selected engine is not known to be compatible.",
        ),
      );
    }
    if (entry.capacity === "rate-limited") {
      issues.push(
        issue("capacity", "rate-limited", "The selected account has a known active rate limit."),
      );
    }
    const model = entry.models.find((candidate) => candidate.id === requirement.model);
    if (model === undefined) {
      issues.push(
        issue(
          `model:${requirement.model}`,
          "missing",
          `Model ${requirement.model} was not discovered.`,
        ),
      );
    } else {
      if (!model.efforts.includes(requirement.effort))
        issues.push(
          issue(
            `effort:${requirement.effort}`,
            "unsupported",
            `Effort ${requirement.effort} is not supported by model ${requirement.model}.`,
          ),
        );
      if (!model.executionModes.includes(requirement.executionMode))
        issues.push(
          issue(
            `execution-mode:${requirement.executionMode}`,
            "unsupported",
            `Execution mode ${requirement.executionMode} is not supported by model ${requirement.model}.`,
          ),
        );
    }
    for (const name of requirement.features ?? []) {
      const state = entry.features[name].support;
      if (state !== "supported")
        issues.push(
          issue(
            name,
            state === "unknown" ? "unknown" : "unsupported",
            `Required feature ${name} is ${state}.`,
          ),
        );
    }
    for (const name of requirement.tools ?? []) {
      const state = entry.features.tools.find((tool) => tool.name === name)?.state.support;
      if (state !== "supported")
        issues.push(
          issue(
            `tool:${name}`,
            state === "unsupported" ? "unsupported" : state === "unknown" ? "unknown" : "missing",
            `Required tool capability ${name} is ${state ?? "missing"}.`,
          ),
        );
    }
  }
  if (issues.length > 0) {
    return {
      ok: false,
      error: { schemaVersion: 1, phase, engine: requirement.engine, accountId, issues },
    };
  }
  return { ok: true, warnings };
}
