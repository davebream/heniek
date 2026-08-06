import { basename, dirname, resolve } from "node:path";
import { CodebaseError } from "./errors.js";
import { buildInstructionSnapshot } from "./instructions.js";
import { normalizeRemoteUrl } from "./remote.js";
import type {
  ClockPort,
  CodebaseDetectionResult,
  CodebaseFileSystem,
  GitPort,
  GitRepositoryObservation,
  HashPort,
  RegisteredCodebase,
} from "./types.js";

export interface DetectCodebaseDeps {
  readonly fs: CodebaseFileSystem;
  readonly git: GitPort;
  readonly hash: HashPort;
  readonly clock: ClockPort;
  readonly registrations?: readonly RegisteredCodebase[];
}

export interface DetectCodebaseInput {
  readonly roots: readonly string[];
  readonly sourceRepositoryPath?: string | null;
}

function commonAncestor(paths: readonly string[]): string {
  if (paths.length === 1) return paths[0] ?? ".";
  let candidate = paths[0] ?? "/";
  while (!paths.every((path) => path === candidate || path.startsWith(`${candidate}/`))) {
    const parent = dirname(candidate);
    if (parent === candidate) return parent;
    candidate = parent;
  }
  return candidate;
}

async function observationsForRoot(
  deps: DetectCodebaseDeps,
  rawRoot: string,
): Promise<GitRepositoryObservation[]> {
  const root = await deps.fs.realpath(resolve(rawRoot));
  const enclosing = await deps.git.inspect(root);
  if (enclosing !== null) return [enclosing];
  const entries = (await deps.fs.list(root))
    .filter((entry) => entry.directory)
    .sort((a, b) => a.name.localeCompare(b.name));
  const observations: GitRepositoryObservation[] = [];
  for (const entry of entries) {
    const observation = await deps.git.inspect(entry.path);
    if (observation !== null && observation.path === (await deps.fs.realpath(entry.path)))
      observations.push(observation);
  }
  return observations;
}

function registrationMatch(
  registration: RegisteredCodebase,
  observations: readonly GitRepositoryObservation[],
): "match" | "none" | "ambiguous" {
  if (registration.repositories.length !== observations.length) return "none";
  const candidates = observations.map((observation) =>
    registration.repositories.flatMap((stored, index) => {
      if (stored.gitCommonDirectory === observation.gitCommonDirectory) return [index];
      const observed = new Set(
        observation.remotes
          .flatMap((remote) => [remote.fetchUrl, remote.pushUrl])
          .filter((url): url is string => url !== null)
          .map((url) => normalizeRemoteUrl(url, observation.path)),
      );
      return stored.remotes.some((remote) =>
        [remote.fetchUrl, remote.pushUrl].some((url) => url !== null && observed.has(url)),
      )
        ? [index]
        : [];
    }),
  );
  if (candidates.some((matches) => matches.length === 0)) return "none";
  if (candidates.some((matches) => matches.length > 1)) return "ambiguous";
  const selected = candidates.flat();
  return new Set(selected).size === selected.length ? "match" : "ambiguous";
}

function repositoryIdForObservation(
  registration: RegisteredCodebase | undefined,
  observation: GitRepositoryObservation,
) {
  if (registration === undefined) return undefined;
  const observed = new Set(
    observation.remotes
      .flatMap((remote) => [remote.fetchUrl, remote.pushUrl])
      .filter((url): url is string => url !== null)
      .map((url) => normalizeRemoteUrl(url, observation.path)),
  );
  const matches = registration.repositories.filter(
    (stored) =>
      stored.gitCommonDirectory === observation.gitCommonDirectory ||
      stored.remotes.some((remote) =>
        [remote.fetchUrl, remote.pushUrl].some((url) => url !== null && observed.has(url)),
      ),
  );
  return matches.length === 1 ? matches[0]?.repositoryId : undefined;
}

export async function detectCodebase(
  deps: DetectCodebaseDeps,
  input: DetectCodebaseInput,
): Promise<CodebaseDetectionResult> {
  const roots = input.roots.length === 0 ? [process.cwd()] : input.roots;
  const discovered = (
    await Promise.all(roots.map((root) => observationsForRoot(deps, root)))
  ).flat();
  const byCommonDirectory = new Map<string, GitRepositoryObservation>();
  for (const observation of discovered) {
    const existing = byCommonDirectory.get(observation.gitCommonDirectory);
    if (existing === undefined || observation.path.localeCompare(existing.path) < 0) {
      byCommonDirectory.set(observation.gitCommonDirectory, observation);
    }
  }
  const observations = [...byCommonDirectory.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (observations.length === 0)
    throw new CodebaseError(
      "NO_REPOSITORIES",
      "No Git repositories were found at the supplied roots.",
    );

  const evidence = (deps.registrations ?? []).map((registration) => ({
    registration,
    match: registrationMatch(registration, observations),
  }));
  const matches = evidence
    .filter((candidate) => candidate.match === "match")
    .map((candidate) => candidate.registration);
  const ambiguous =
    matches.length > 1 || evidence.some((candidate) => candidate.match === "ambiguous");
  const match = matches.length === 1 ? matches[0] : undefined;
  const normalized = observations.map((observation) => {
    const remotes = observation.remotes
      .map((remote) => ({
        name: remote.name,
        fetchUrl:
          remote.fetchUrl === null ? null : normalizeRemoteUrl(remote.fetchUrl, observation.path),
        pushUrl:
          remote.pushUrl === null ? null : normalizeRemoteUrl(remote.pushUrl, observation.path),
        defaultBranch: remote.defaultBranch,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      ...observation,
      repositoryId: repositoryIdForObservation(match, observation) ?? null,
      name: basename(observation.path),
      remotes,
    };
  });
  const rootPath = commonAncestor(observations.map((repository) => repository.path));
  const sourceRepositoryPath =
    input.sourceRepositoryPath === undefined || input.sourceRepositoryPath === null
      ? null
      : await deps.fs.realpath(resolve(input.sourceRepositoryPath));
  const topologyBody = JSON.stringify(
    normalized.map(
      ({ visibleFiles: _visibleFiles, repositoryId: _repositoryId, ...repository }) => repository,
    ),
  );
  const topologySha256 = deps.hash.sha256(topologyBody);
  const instructionSnapshot = await buildInstructionSnapshot(
    deps.fs,
    deps.hash,
    deps.clock.nowIso(),
    normalized,
  );
  const diagnostics = normalized.flatMap((repository) => {
    const results: CodebaseDetectionResult["diagnostics"][number][] = [];
    if (repository.remotes.length === 0)
      results.push({
        code: "REMOTE_MISSING",
        severity: "blocker",
        message: "Repository has no configured remote.",
        repositoryPath: repository.path,
      });
    if (repository.defaultBranch === null)
      results.push({
        code: "DEFAULT_BRANCH_UNKNOWN",
        severity: "blocker",
        message: "Repository default branch could not be resolved locally.",
        repositoryPath: repository.path,
      });
    return results;
  });
  if (ambiguous)
    diagnostics.push({
      code: "AMBIGUOUS_REGISTRATION",
      severity: "blocker",
      message: "Observed repositories match more than one registered Codebase.",
      repositoryPath: null,
    });
  return {
    schemaVersion: 1,
    registrationState: ambiguous
      ? "ambiguous"
      : match === undefined
        ? "unregistered"
        : "registered",
    codebaseId: match?.codebaseId ?? null,
    name: match?.name ?? basename(rootPath),
    rootPath,
    sourceRepositoryPath,
    topologySha256,
    repositories: normalized.map(({ visibleFiles: _visibleFiles, ...repository }) => repository),
    instructionSnapshot,
    diagnostics,
  };
}
