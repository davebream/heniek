import type { RepositoryId } from "@heniek/contracts";
import { parse, stringify } from "yaml";
import { type DetectCodebaseDeps, type DetectCodebaseInput, detectCodebase } from "./detect.js";
import { CodebaseError } from "./errors.js";
import type { IdPort, RegisteredCodebase } from "./types.js";

export interface RegistrationStatePort {
  commitRegistration(registration: RegisteredCodebase): Promise<void>;
}

export interface RegisterCodebaseDeps extends Omit<DetectCodebaseDeps, "registrations"> {
  readonly codebasesDirectory: string;
  readonly ids: IdPort;
  readonly state: RegistrationStatePort;
}

export interface RegisterCodebaseInput extends DetectCodebaseInput {
  readonly expectedTopologySha256: string;
  readonly confirmed: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

function registrationBody(registration: Omit<RegisteredCodebase, "configurationSha256">): string {
  return JSON.stringify(canonicalValue(registration));
}

function parseRegistration(value: unknown, hash: RegisterCodebaseDeps["hash"]): RegisteredCodebase {
  if (!isRecord(value))
    throw new CodebaseError(
      "REGISTRATION_FILE_CONFLICT",
      "Codebase configuration is not an object.",
    );
  const configurationSha256 = value.configurationSha256;
  if (typeof configurationSha256 !== "string")
    throw new CodebaseError(
      "REGISTRATION_FILE_CONFLICT",
      "Codebase configuration has no content hash.",
    );
  const { configurationSha256: _ignored, ...body } = value;
  if (hash.sha256(JSON.stringify(canonicalValue(body))) !== configurationSha256) {
    throw new CodebaseError(
      "REGISTRATION_FILE_CONFLICT",
      "Codebase configuration changed outside the registration transaction.",
    );
  }
  return value as unknown as RegisteredCodebase;
}

export async function loadRegistrations(
  deps: Pick<RegisterCodebaseDeps, "fs" | "hash" | "codebasesDirectory">,
): Promise<RegisteredCodebase[]> {
  if (!(await deps.fs.exists(deps.codebasesDirectory))) return [];
  const registrations: RegisteredCodebase[] = [];
  for (const entry of (await deps.fs.list(deps.codebasesDirectory))
    .filter((candidate) => candidate.directory)
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${entry.path}/codebase.yaml`;
    if (!(await deps.fs.exists(path))) continue;
    registrations.push(parseRegistration(parse(await deps.fs.readText(path)), deps.hash));
  }
  return registrations;
}

function attachRepositoryIds(
  registration: Omit<RegisteredCodebase, "configurationSha256">,
  ids: IdPort,
  hash: RegisterCodebaseDeps["hash"],
): Omit<RegisteredCodebase, "configurationSha256"> {
  const repositories = registration.repositories.map((repository) => ({
    ...repository,
    repositoryId: (repository.repositoryId ?? ids.next("repo")) as RepositoryId,
  }));
  const sources = registration.instructionSnapshot.sources.map((source) => ({
    ...source,
    location:
      source.location.kind === "repository"
        ? {
            ...source.location,
            repositoryId:
              repositories.find(
                (repository) =>
                  `ins-${hash.sha256(`repository:${repository.path}:${source.location.path}`).slice(0, 24)}` ===
                  source.sourceId,
              )?.repositoryId ?? null,
          }
        : source.location,
  }));
  return {
    ...registration,
    repositories,
    instructionSnapshot: { ...registration.instructionSnapshot, sources },
  };
}

export async function registerCodebase(
  deps: RegisterCodebaseDeps,
  input: RegisterCodebaseInput,
): Promise<RegisteredCodebase> {
  if (input.confirmed !== true)
    throw new CodebaseError(
      "REGISTRATION_NOT_CONFIRMED",
      "Codebase registration requires explicit confirmation.",
    );
  const registrations = await loadRegistrations(deps);
  const detection = await detectCodebase({ ...deps, registrations }, input);
  if (detection.registrationState === "ambiguous")
    throw new CodebaseError(
      "AMBIGUOUS_REGISTRATION",
      "Repositories match multiple registered Codebases.",
    );
  if (detection.topologySha256 !== input.expectedTopologySha256)
    throw new CodebaseError(
      "TOPOLOGY_CHANGED",
      "Repository topology changed after confirmation; detect again.",
      true,
    );
  if (detection.registrationState === "registered") {
    const existing = registrations.find(
      (registration) => registration.codebaseId === detection.codebaseId,
    );
    if (existing === undefined)
      throw new CodebaseError(
        "REGISTRATION_FILE_CONFLICT",
        "Registered Codebase could not be loaded.",
      );
    await deps.state.commitRegistration(existing);
    return existing;
  }

  const registeredAt = deps.clock.nowIso();
  const codebaseId = deps.ids.next("cb") as RegisteredCodebase["codebaseId"];
  let withoutHash: Omit<RegisteredCodebase, "configurationSha256"> = {
    schemaVersion: 1,
    codebaseId,
    name: detection.name,
    rootPath: detection.rootPath,
    sourceRepositoryPath: detection.sourceRepositoryPath,
    topologySha256: detection.topologySha256,
    repositories: detection.repositories,
    instructionSnapshot: detection.instructionSnapshot,
    diagnostics: detection.diagnostics,
    readiness:
      detection.instructionSnapshot.readiness === "blocked" ||
      detection.diagnostics.some((entry) => entry.severity === "blocker")
        ? "blocked"
        : "ready",
    registeredAt,
  };
  withoutHash = attachRepositoryIds(withoutHash, deps.ids, deps.hash);
  const snapshotBody = JSON.stringify({
    sources: withoutHash.instructionSnapshot.sources,
    diagnostics: withoutHash.instructionSnapshot.diagnostics,
  });
  withoutHash = {
    ...withoutHash,
    instructionSnapshot: {
      ...withoutHash.instructionSnapshot,
      snapshotSha256: deps.hash.sha256(snapshotBody),
    },
  };
  const registration: RegisteredCodebase = {
    ...withoutHash,
    configurationSha256: deps.hash.sha256(registrationBody(withoutHash)),
  };
  const directory = `${deps.codebasesDirectory}/${codebaseId}`;
  const path = `${directory}/codebase.yaml`;
  await deps.fs.mkdir(directory);
  if (await deps.fs.exists(path)) {
    const existing = parseRegistration(parse(await deps.fs.readText(path)), deps.hash);
    if (existing.configurationSha256 !== registration.configurationSha256)
      throw new CodebaseError(
        "REGISTRATION_FILE_CONFLICT",
        "Registration target already contains different content.",
      );
  } else {
    await deps.fs.writeTextAtomic(path, stringify(registration, { sortMapEntries: true }));
  }
  await deps.state.commitRegistration(registration);
  return registration;
}
