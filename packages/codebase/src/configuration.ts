import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
  ConfigurationLayerDocument,
  ConfigurationProvenance,
  Diagnostic,
  JsonObject,
} from "@heniek/config";
import {
  createDiagnostic,
  loadRestrictedYamlDocument,
  resolveConfiguration,
  sortDiagnostics,
} from "@heniek/config";
import type {
  CodebaseConfiguration,
  RepositoryBasePin,
  RepositoryProvisioningConfiguration,
  ResolvedCodebaseSnapshot,
} from "@heniek/contracts";
import { CodebaseConfigurationV1 } from "@heniek/contracts";
import { LineCounter, parseDocument } from "yaml";
import { normalizeRemoteUrl } from "./remote.js";
import type { ClockPort, HashPort, RegisteredCodebase } from "./types.js";

const CONFIGURATION_FIELDS = [
  "expectedPath",
  "setup",
  "provisioning/strategy",
  "provisioning/remote",
  "provisioning/requestedRef",
  "provisioning/synchronization",
  "provisioning/checkoutPath",
  "provisioning/command",
] as const;

export type BaseResolutionFailure = "missing" | "unauthorized" | "failed";

export interface BaseResolutionCommandResult {
  readonly kind: "ok" | BaseResolutionFailure;
  readonly stdout: string;
}

export interface BaseResolutionGitPort {
  run(repositoryPath: string, args: readonly string[]): Promise<BaseResolutionCommandResult>;
}

export interface ResolveCodebaseConfigurationInput {
  readonly registration: RegisteredCodebase;
  readonly documents: readonly ConfigurationLayerDocument[];
  /** Source text by absolute source path, used only to attach line/column diagnostics. */
  readonly sourceTexts?: Readonly<Record<string, string>>;
}

export type ResolveCodebaseConfigurationResult =
  | { readonly ok: true; readonly snapshot: ResolvedCodebaseSnapshot }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface ResolveCodebaseConfigurationDeps {
  readonly clock: ClockPort;
  readonly git: BaseResolutionGitPort;
  readonly hash?: HashPort;
}

export interface LoadCodebaseConfigurationDeps extends ResolveCodebaseConfigurationDeps {
  readonly fs: Pick<import("./types.js").CodebaseFileSystem, "exists" | "readText">;
  readonly codebasesDirectory: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function sourcePosition(source: string | undefined, pointer: string) {
  if (source === undefined) return {};
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter, keepSourceTokens: true });
  const node = document.getIn(pointerSegments(pointer), true) as {
    range?: readonly number[];
  } | null;
  const offset = node?.range?.[0];
  if (offset === undefined) return {};
  const position = lineCounter.linePos(offset);
  return { line: position.line, column: position.col };
}

function provenanceFor(
  provenance: readonly ConfigurationProvenance[],
  pointer: string,
): ConfigurationProvenance | undefined {
  return (
    provenance.find((entry) => entry.pointer === pointer) ??
    provenance.find((entry) => entry.pointer.startsWith(`${pointer}/`)) ??
    [...provenance].reverse().find((entry) => pointer.startsWith(`${entry.pointer}/`))
  );
}

function diagnosticAt(
  code: string,
  message: string,
  pointer: string,
  provenance: readonly ConfigurationProvenance[],
  sourceTexts: Readonly<Record<string, string>>,
): Diagnostic {
  const origin = provenanceFor(provenance, pointer);
  const sourcePath = origin?.sourcePath;
  return createDiagnostic(code, "error", message, {
    pointer,
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...sourcePosition(
      sourcePath === undefined ? undefined : sourceTexts[sourcePath],
      origin?.pointer ?? pointer,
    ),
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProvisioning(value: unknown): value is RepositoryProvisioningConfiguration {
  if (!isObject(value) || typeof value.strategy !== "string") return false;
  if (value.strategy === "current-checkout") return Object.keys(value).length === 1;
  if (value.strategy === "existing-checkout") {
    return typeof value.checkoutPath === "string" && isAbsolute(value.checkoutPath);
  }
  if (value.strategy === "custom") return typeof value.command === "string" && value.command !== "";
  return (
    value.strategy === "managed-worktree" &&
    typeof value.remote === "string" &&
    value.remote !== "" &&
    typeof value.requestedRef === "string" &&
    value.requestedRef !== "" &&
    ["notify", "pinned", "rebase-before-build", "merge-before-build", "custom"].includes(
      String(value.synchronization),
    )
  );
}

function configurationPolicy(repositoryIds: readonly string[]) {
  return {
    rules: repositoryIds.flatMap((repositoryId) =>
      CONFIGURATION_FIELDS.map((field) => ({
        kind: "overridable" as const,
        pointer: `/repositories/${repositoryId}/${field}`,
      })),
    ),
  };
}

function safeRequestedRef(value: string): boolean {
  const hasForbiddenCharacter = [...value].some(
    (character) => character.charCodeAt(0) <= 32 || "~^:?*[\\".includes(character),
  );
  return (
    value === "auto" ||
    (!value.startsWith("-") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !hasForbiddenCharacter)
  );
}

function hasCredentialMaterial(value: string): boolean {
  const trimmed = value.trim();
  const scp = /^([^/@:]+)@[^/:]+:.+$/.exec(trimmed);
  if (scp !== null) return scp[1] !== "git";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.password !== "" || (parsed.username !== "" && parsed.username !== "git");
  } catch {
    return true;
  }
}

function branchFromRequestedRef(requestedRef: string): string {
  return requestedRef.startsWith("refs/heads/")
    ? requestedRef.slice("refs/heads/".length)
    : requestedRef;
}

async function advertisedBranch(
  git: BaseResolutionGitPort,
  repositoryPath: string,
  remote: string,
  branch: string,
): Promise<BaseResolutionCommandResult> {
  return git.run(repositoryPath, ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`]);
}

async function resolveBranch(
  git: BaseResolutionGitPort,
  repositoryPath: string,
  remote: string,
  requestedRef: string,
): Promise<{ branch?: string; failure?: BaseResolutionFailure }> {
  if (requestedRef !== "auto") return { branch: branchFromRequestedRef(requestedRef) };
  const head = await git.run(repositoryPath, ["ls-remote", "--symref", remote, "HEAD"]);
  if (head.kind === "unauthorized") return { failure: "unauthorized" };
  if (head.kind === "ok") {
    const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m.exec(head.stdout);
    if (match?.[1] !== undefined) return { branch: match[1] };
  }
  for (const fallback of ["main", "master"] as const) {
    const advertised = await advertisedBranch(git, repositoryPath, remote, fallback);
    if (advertised.kind === "ok") return { branch: fallback };
    if (advertised.kind === "unauthorized") return { failure: "unauthorized" };
  }
  return { failure: "missing" };
}

async function resolveBasePin(
  deps: ResolveCodebaseConfigurationDeps,
  repository: RegisteredCodebase["repositories"][number],
  provisioning: Extract<RepositoryProvisioningConfiguration, { strategy: "managed-worktree" }>,
): Promise<RepositoryBasePin | { readonly failure: BaseResolutionFailure | "moved" }> {
  const remoteObservation = repository.remotes.find(
    (remote) => remote.name === provisioning.remote,
  );
  if (remoteObservation?.fetchUrl === null || remoteObservation === undefined)
    return { failure: "missing" };
  const remoteUrl = await deps.git.run(repository.path, ["remote", "get-url", provisioning.remote]);
  if (remoteUrl.kind !== "ok") return { failure: remoteUrl.kind };
  if (hasCredentialMaterial(remoteUrl.stdout)) return { failure: "unauthorized" };
  const fetchedRemoteIdentity = normalizeRemoteUrl(remoteUrl.stdout, repository.path);
  if (fetchedRemoteIdentity !== remoteObservation.fetchUrl) return { failure: "moved" };
  const selected = await resolveBranch(
    deps.git,
    repository.path,
    provisioning.remote,
    provisioning.requestedRef,
  );
  if (selected.failure !== undefined || selected.branch === undefined) {
    return { failure: selected.failure ?? "missing" };
  }
  const branch = selected.branch;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fetch = await deps.git.run(repository.path, [
      "fetch",
      "--no-tags",
      provisioning.remote,
      `+refs/heads/${branch}:refs/remotes/${provisioning.remote}/${branch}`,
    ]);
    if (fetch.kind !== "ok") return { failure: fetch.kind };
    const fetched = await deps.git.run(repository.path, [
      "rev-parse",
      "--verify",
      `refs/remotes/${provisioning.remote}/${branch}^{commit}`,
    ]);
    if (fetched.kind !== "ok") return { failure: fetched.kind };
    const advertised = await advertisedBranch(
      deps.git,
      repository.path,
      provisioning.remote,
      branch,
    );
    if (advertised.kind !== "ok") return { failure: advertised.kind };
    const advertisedSha = advertised.stdout.trim().split(/\s+/)[0];
    const commitSha = fetched.stdout.trim();
    if (advertisedSha === commitSha && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commitSha)) {
      return {
        schemaVersion: 1,
        repositoryId: repository.repositoryId as RepositoryBasePin["repositoryId"],
        requestedRef: provisioning.requestedRef,
        resolvedRef: `refs/heads/${branch}`,
        remote: provisioning.remote,
        fetchedRemoteIdentity,
        commitSha,
        resolvedAt: deps.clock.nowIso(),
        synchronization: provisioning.synchronization,
      };
    }
  }
  return { failure: "moved" };
}

export async function resolveCodebaseConfiguration(
  deps: ResolveCodebaseConfigurationDeps,
  input: ResolveCodebaseConfigurationInput,
): Promise<ResolveCodebaseConfigurationResult> {
  const sourceTexts = input.sourceTexts ?? {};
  const registeredIds = input.registration.repositories.flatMap((repository) =>
    repository.repositoryId === null ? [] : [repository.repositoryId],
  );
  const resolved = resolveConfiguration({
    documents: input.documents,
    policy: configurationPolicy(registeredIds),
  });
  const diagnostics: Diagnostic[] = [...resolved.diagnostics];
  const value = resolved.values as Record<string, unknown>;
  const repositoriesValue = isObject(value.repositories) ? value.repositories : {};
  if (value.schemaVersion !== 1 || value.codebaseId !== input.registration.codebaseId) {
    diagnostics.push(
      diagnosticAt(
        "codebase.configuration-identity-mismatch",
        "Configuration must use schemaVersion 1 and the registered Codebase ID.",
        "/codebaseId",
        resolved.provenance,
        sourceTexts,
      ),
    );
  }

  const configuredIds = Object.keys(repositoriesValue).sort();
  for (const repositoryId of configuredIds) {
    if (!registeredIds.includes(repositoryId as never)) {
      diagnostics.push(
        diagnosticAt(
          "codebase.repository-missing",
          "Configured repository ID is not registered to this Codebase.",
          `/repositories/${repositoryId}`,
          resolved.provenance,
          sourceTexts,
        ),
      );
    }
  }
  for (const repositoryId of registeredIds) {
    if (!(repositoryId in repositoriesValue)) {
      diagnostics.push(
        diagnosticAt(
          "codebase.repository-configuration-missing",
          "Registered repository has no effective configuration.",
          `/repositories/${repositoryId}`,
          resolved.provenance,
          sourceTexts,
        ),
      );
    }
  }

  const effective: {
    repository: RegisteredCodebase["repositories"][number];
    provisioning: RepositoryProvisioningConfiguration;
    setup: string | null;
    provenance: ResolvedCodebaseSnapshot["repositories"][number]["provenance"];
  }[] = [];
  const remoteOwners = new Map<string, string>();
  for (const repository of input.registration.repositories) {
    const repositoryId = repository.repositoryId;
    if (repositoryId === null) continue;
    const pointer = `/repositories/${repositoryId}`;
    const configured = repositoriesValue[repositoryId];
    if (!isObject(configured)) continue;
    if (configured.expectedPath !== repository.path) {
      diagnostics.push(
        diagnosticAt(
          "codebase.repository-moved",
          "Configured repository path no longer matches the registered repository.",
          `${pointer}/expectedPath`,
          resolved.provenance,
          sourceTexts,
        ),
      );
    }
    if (!isProvisioning(configured.provisioning)) {
      diagnostics.push(
        diagnosticAt(
          "codebase.provisioning-invalid",
          "Provisioning configuration is incomplete or invalid for its strategy.",
          `${pointer}/provisioning`,
          resolved.provenance,
          sourceTexts,
        ),
      );
      continue;
    }
    const provisioning = configured.provisioning;
    const setup = configured.setup;
    if (!(setup === null || (typeof setup === "string" && setup !== ""))) {
      diagnostics.push(
        diagnosticAt(
          "codebase.setup-invalid",
          "Setup must be null or a non-empty command.",
          `${pointer}/setup`,
          resolved.provenance,
          sourceTexts,
        ),
      );
      continue;
    }
    if (provisioning.strategy === "managed-worktree") {
      if (!safeRequestedRef(provisioning.requestedRef)) {
        diagnostics.push(
          diagnosticAt(
            "codebase.base-ref-invalid",
            "Managed base ref is not a safe branch reference.",
            `${pointer}/provisioning/requestedRef`,
            resolved.provenance,
            sourceTexts,
          ),
        );
      }
      const remote = repository.remotes.find((candidate) => candidate.name === provisioning.remote);
      if (remote?.fetchUrl === null || remote === undefined) {
        diagnostics.push(
          diagnosticAt(
            "codebase.remote-missing",
            "Configured remote is not available on the registered repository.",
            `${pointer}/provisioning/remote`,
            resolved.provenance,
            sourceTexts,
          ),
        );
      } else {
        const owner = remoteOwners.get(remote.fetchUrl);
        if (owner !== undefined && owner !== repositoryId) {
          diagnostics.push(
            diagnosticAt(
              "codebase.remote-ambiguous",
              "A canonical fetch remote may belong to only one repository in a Codebase.",
              `${pointer}/provisioning/remote`,
              resolved.provenance,
              sourceTexts,
            ),
          );
        } else {
          remoteOwners.set(remote.fetchUrl, repositoryId);
        }
      }
    }
    const repositoryProvenance = resolved.provenance
      .filter((entry) => entry.pointer.startsWith(`${pointer}/`))
      .map((entry) => ({
        layer: entry.layer,
        sourcePath: entry.sourcePath ?? "<memory>",
        pointer: entry.pointer,
      }));
    effective.push({
      repository,
      provisioning,
      setup,
      provenance: repositoryProvenance,
    });
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  const managed = effective.filter(
    (
      entry,
    ): entry is typeof entry & {
      provisioning: Extract<RepositoryProvisioningConfiguration, { strategy: "managed-worktree" }>;
    } => entry.provisioning.strategy === "managed-worktree",
  );
  const pins = await Promise.all(
    managed.map(async (entry) => ({
      entry,
      pin: await resolveBasePin(deps, entry.repository, entry.provisioning),
    })),
  );
  for (const { entry, pin } of pins) {
    if ("failure" in pin) {
      const repositoryId = entry.repository.repositoryId as string;
      const code =
        pin.failure === "unauthorized"
          ? "codebase.repository-unauthorized"
          : pin.failure === "moved"
            ? "codebase.remote-moved"
            : "codebase.base-missing";
      diagnostics.push(
        diagnosticAt(
          code,
          pin.failure === "unauthorized"
            ? "Repository remote could not be accessed with the active subscription credentials."
            : pin.failure === "moved"
              ? "Repository remote moved during base resolution or no longer matches registration."
              : "Repository remote or requested base could not be resolved.",
          `/repositories/${repositoryId}/provisioning/remote`,
          resolved.provenance,
          sourceTexts,
        ),
      );
    }
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  const basePins = pins
    .map(({ pin }) => pin as RepositoryBasePin)
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  const hash = deps.hash?.sha256 ?? sha256;
  const configuration = resolved.values as unknown as CodebaseConfiguration;
  const resolvedAt = deps.clock.nowIso();
  return {
    ok: true,
    snapshot: {
      schemaVersion: 1,
      codebaseId: input.registration.codebaseId,
      registrationSha256: input.registration.configurationSha256,
      configurationSha256: hash(JSON.stringify(canonicalValue(configuration))),
      resolvedAt,
      repositories: effective
        .map((entry) => ({
          repositoryId: entry.repository.repositoryId as NonNullable<
            typeof entry.repository.repositoryId
          >,
          name: entry.repository.name,
          path: entry.repository.path,
          provisioning: entry.provisioning,
          setup: entry.setup,
          provenance: entry.provenance,
        }))
        .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)),
      basePins,
    },
  };
}

/** Paths used by application-home callers; no repository-local state is created. */
export function codebaseConfigurationPath(codebasesDirectory: string, codebaseId: string): string {
  return `${codebasesDirectory}/${codebaseId}/workspace.yaml`;
}

export function configurationDocument(
  layer: ConfigurationLayerDocument["layer"],
  sourcePath: string,
  values: JsonObject,
): ConfigurationLayerDocument {
  return { layer, sourcePath, values };
}

/** Loads the authored Codebase layer from application home, then applies caller-supplied higher layers. */
export async function loadAndResolveCodebaseConfiguration(
  deps: LoadCodebaseConfigurationDeps,
  input: Omit<ResolveCodebaseConfigurationInput, "documents" | "sourceTexts"> & {
    readonly overrides?: readonly ConfigurationLayerDocument[];
    readonly overrideSourceTexts?: Readonly<Record<string, string>>;
  },
): Promise<ResolveCodebaseConfigurationResult> {
  const path = codebaseConfigurationPath(deps.codebasesDirectory, input.registration.codebaseId);
  if (!(await deps.fs.exists(path))) {
    return {
      ok: false,
      diagnostics: [
        createDiagnostic(
          "codebase.configuration-missing",
          "error",
          "Registered Codebase has no application-home workspace configuration.",
          { sourcePath: path },
        ),
      ],
    };
  }
  const source = await deps.fs.readText(path);
  const parsed = loadRestrictedYamlDocument<CodebaseConfiguration>(
    source,
    CodebaseConfigurationV1,
    { sourcePath: path },
  );
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  return resolveCodebaseConfiguration(deps, {
    registration: input.registration,
    documents: [
      configurationDocument("codebase", path, parsed.value as unknown as JsonObject),
      ...(input.overrides ?? []),
    ],
    sourceTexts: { [path]: source, ...(input.overrideSourceTexts ?? {}) },
  });
}
