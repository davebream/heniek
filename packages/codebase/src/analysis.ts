import { spawn } from "node:child_process";
import type {
  AnalysisPacketId,
  CompositeWorkspaceProvisioningManifest,
  RepositoryId,
  ResolvedCodebaseSnapshotV2,
  WholeCodebaseAnalysisPacket,
} from "@heniek/contracts";
import { CodebaseError } from "./errors.js";

export const DEFAULT_ANALYSIS_INDEX_MAX_ENTRIES = 10_000;
export const DEFAULT_ANALYSIS_INDEX_MAX_BYTES = 1024 * 1024;

type RepositoryIndex = WholeCodebaseAnalysisPacket["repositories"][number]["index"];
type RepositoryIndexEntry = RepositoryIndex["entries"][number];

export interface AnalysisClock {
  nowIso(): string;
}

export interface AnalysisPacketIdSource {
  next(): AnalysisPacketId;
}

export interface RepositoryIndexPort {
  index(
    checkoutPath: string,
    headSha: string,
    limits: { readonly maxEntries: number; readonly maxBytes: number },
  ): Promise<RepositoryIndex>;
}

export interface BuildWholeCodebaseAnalysisPacketInput {
  readonly sourceRepositoryId: RepositoryId;
  readonly snapshot: ResolvedCodebaseSnapshotV2;
  readonly composite: CompositeWorkspaceProvisioningManifest;
  readonly limits?: { readonly maxEntries?: number; readonly maxBytes?: number };
}

export interface WholeCodebaseAnalysisService {
  build(input: BuildWholeCodebaseAnalysisPacketInput): Promise<WholeCodebaseAnalysisPacket>;
}

function assertLimit(value: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new CodebaseError("CONFIGURATION_CHANGED", `${label} is outside the public contract.`);
  }
}

export function createWholeCodebaseAnalysisService(deps: {
  readonly clock: AnalysisClock;
  readonly ids: AnalysisPacketIdSource;
  readonly index: RepositoryIndexPort;
}): WholeCodebaseAnalysisService {
  return {
    async build(input) {
      if (input.composite.lifecycle !== "ready" || input.composite.effectiveInstructions === null) {
        throw new CodebaseError(
          "CONFIGURATION_CHANGED",
          "Whole-Codebase analysis requires a ready composite workspace and instructions.",
        );
      }
      if (
        input.snapshot.codebaseId !== input.composite.codebaseId ||
        input.snapshot.configurationSha256 !== input.composite.configurationSha256
      ) {
        throw new CodebaseError(
          "CONFIGURATION_CHANGED",
          "Resolved Codebase and composite workspace identities do not match.",
        );
      }

      const maxEntries = input.limits?.maxEntries ?? DEFAULT_ANALYSIS_INDEX_MAX_ENTRIES;
      const maxBytes = input.limits?.maxBytes ?? DEFAULT_ANALYSIS_INDEX_MAX_BYTES;
      assertLimit(maxEntries, DEFAULT_ANALYSIS_INDEX_MAX_ENTRIES, "Analysis index entry limit");
      assertLimit(maxBytes, DEFAULT_ANALYSIS_INDEX_MAX_BYTES, "Analysis index byte limit");

      const resolved = new Map(
        input.snapshot.repositories.map((repository) => [repository.repositoryId, repository]),
      );
      const composite = new Map(
        input.composite.repositories.map((repository) => [repository.repositoryId, repository]),
      );
      if (
        resolved.size !== input.snapshot.repositories.length ||
        composite.size !== input.composite.repositories.length ||
        resolved.size !== composite.size ||
        [...resolved.keys()].some((repositoryId) => !composite.has(repositoryId))
      ) {
        throw new CodebaseError(
          "TOPOLOGY_CHANGED",
          "Resolved Codebase and composite workspace repository inventories do not match.",
        );
      }
      if (!resolved.has(input.sourceRepositoryId)) {
        throw new CodebaseError("UNKNOWN_REPOSITORY", "Source repository is not in the Codebase.");
      }

      const pins = new Map(input.snapshot.basePins.map((pin) => [pin.repositoryId, pin]));
      if (
        pins.size !== input.snapshot.basePins.length ||
        [...pins.keys()].some((repositoryId) => {
          const repository = resolved.get(repositoryId);
          return (
            repository === undefined || repository.provisioning.strategy !== "managed-worktree"
          );
        }) ||
        [...resolved.values()].some(
          (repository) =>
            repository.provisioning.strategy === "managed-worktree" &&
            !pins.has(repository.repositoryId),
        )
      ) {
        throw new CodebaseError(
          "TOPOLOGY_CHANGED",
          "Resolved Codebase base-pin inventory does not match its managed repositories.",
        );
      }
      const repositories: WholeCodebaseAnalysisPacket["repositories"] = [];
      for (const repositoryId of [...resolved.keys()].toSorted()) {
        const configured = resolved.get(repositoryId);
        const provisioned = composite.get(repositoryId);
        if (
          configured === undefined ||
          provisioned === undefined ||
          provisioned.checkoutPath === null ||
          provisioned.checkoutHeadSha === null ||
          provisioned.baseSha === null ||
          provisioned.phase !== "completed"
        ) {
          throw new CodebaseError(
            "REPOSITORY_MUTATED",
            "Analysis repository is not fully materialized at a verified HEAD.",
          );
        }
        if (
          configured.name !== provisioned.name ||
          configured.provisioning.strategy !== provisioned.strategy ||
          provisioned.checkoutHeadSha !== provisioned.baseSha
        ) {
          throw new CodebaseError(
            "REPOSITORY_MUTATED",
            "Analysis repository identity or checkout HEAD changed after resolution.",
          );
        }
        const pin = pins.get(repositoryId);
        if (pin !== undefined && pin.commitSha !== provisioned.baseSha) {
          throw new CodebaseError(
            "REPOSITORY_MUTATED",
            "Managed repository checkout does not match its immutable base pin.",
          );
        }
        repositories.push({
          repositoryId,
          name: provisioned.name,
          checkoutPath: provisioned.checkoutPath,
          base: {
            kind: pin === undefined ? "adopted-head" : "managed-pin",
            sha: provisioned.baseSha,
          },
          index: await deps.index.index(provisioned.checkoutPath, provisioned.baseSha, {
            maxEntries,
            maxBytes,
          }),
        });
      }

      return {
        schemaVersion: 1,
        packetId: deps.ids.next(),
        codebaseId: input.snapshot.codebaseId,
        workspaceId: input.composite.workspaceId,
        sourceRepositoryId: input.sourceRepositoryId,
        registrationSha256: input.snapshot.registrationSha256,
        configurationSha256: input.snapshot.configurationSha256,
        effectiveInstructions: input.composite.effectiveInstructions,
        repositories,
        createdAt: deps.clock.nowIso(),
      };
    },
  };
}

function parseIndexEntry(record: string): RepositoryIndexEntry {
  const tab = record.indexOf("\t");
  const path = tab === -1 ? "" : record.slice(tab + 1);
  const metadata =
    tab === -1
      ? undefined
      : /^([0-7]{6}) (blob|commit) ([0-9a-f]+) +(-|\d+)$/u.exec(record.slice(0, tab));
  const mode = metadata?.[1];
  const type = metadata?.[2];
  const objectId = metadata?.[3];
  const size = metadata?.[4];
  if (
    mode === undefined ||
    type === undefined ||
    objectId === undefined ||
    size === undefined ||
    !/^[0-7]{6}$/.test(mode) ||
    (type !== "blob" && type !== "commit") ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(objectId) ||
    path.length === 0
  ) {
    throw new CodebaseError(
      "REPOSITORY_MUTATED",
      "Git returned an invalid repository index record.",
    );
  }
  const byteLength = size === "-" ? null : Number(size);
  if (byteLength !== null && (!Number.isSafeInteger(byteLength) || byteLength < 0)) {
    throw new CodebaseError(
      "REPOSITORY_MUTATED",
      "Git returned an invalid repository object size.",
    );
  }
  return { path, mode, type, objectId, byteLength };
}

/** Stream Git's NUL-delimited tree so retained packet data is hard-bounded. */
export function createNodeRepositoryIndexPort(): RepositoryIndexPort {
  return {
    async index(checkoutPath, headSha, limits) {
      return await new Promise<RepositoryIndex>((resolve, reject) => {
        const child = spawn(
          "git",
          ["-C", checkoutPath, "ls-tree", "-r", "-l", "-z", "--full-tree", headSha],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let pending = Buffer.alloc(0);
        let stderr = "";
        let observedEntries = 0;
        let observedBytes = 0;
        let emittedBytes = 0;
        const entries: RepositoryIndexEntry[] = [];

        const consume = (record: Buffer) => {
          const entry = parseIndexEntry(record.toString("utf8"));
          const encodedBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
          observedEntries += 1;
          observedBytes += encodedBytes;
          if (
            entries.length < limits.maxEntries &&
            emittedBytes + encodedBytes <= limits.maxBytes
          ) {
            entries.push(entry);
            emittedBytes += encodedBytes;
          }
        };

        child.stdout.on("data", (chunk: Buffer) => {
          pending = Buffer.concat([pending, chunk]);
          let separator = pending.indexOf(0);
          while (separator !== -1) {
            const record = pending.subarray(0, separator);
            pending = pending.subarray(separator + 1);
            try {
              consume(record);
            } catch (error) {
              child.kill("SIGTERM");
              reject(error);
              return;
            }
            separator = pending.indexOf(0);
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < 1024) stderr += chunk.toString("utf8");
        });
        child.on("error", () => {
          reject(new CodebaseError("REPOSITORY_MUTATED", "Unable to inspect repository index."));
        });
        child.on("close", (code) => {
          if (code !== 0 || pending.length !== 0) {
            reject(
              new CodebaseError(
                "REPOSITORY_MUTATED",
                `Unable to inspect repository index${stderr === "" ? "." : ": Git failed."}`,
              ),
            );
            return;
          }
          resolve({
            maxEntries: limits.maxEntries,
            maxBytes: limits.maxBytes,
            observedEntries,
            observedBytes,
            emittedEntries: entries.length,
            emittedBytes,
            truncated: entries.length !== observedEntries,
            entries,
          });
        });
      });
    },
  };
}
