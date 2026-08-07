import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ApplicationHome } from "@heniek/config";
import { x as extractTar } from "tar";
import { ClaudexorRuntimeError } from "./errors.js";
import {
  type ClaudexorRuntimeManifest,
  DEFAULT_CLAUDEXOR_ARCHIVE_SHA256,
  DEFAULT_CLAUDEXOR_BUILD_SHA,
  DEFAULT_CLAUDEXOR_VERSION,
  parseAndVerifyRuntimeManifest,
  runtimeManifestUrl,
  sha256,
} from "./release.js";
import type {
  RuntimeCompatibilityGate,
  RuntimeCompatibilityReport,
  RuntimeIdentity,
  RuntimeIdentityProbe,
  RuntimeInventory,
  RuntimeMutationResult,
} from "./types.js";

const ENGINE = "claudexor";
const ENTRY_NAME = "claudexord.bundle.cjs";
const INSTALL_RECORD_NAME = "heniek-install.json";
const ACTIVE_DESCRIPTOR_NAME = "active.json";
const LOCK_NAME = ".operation.lock";
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const STAGING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export const CLAUDEXOR_PROMOTION_SUITE_VERSION = 1;
export const REQUIRED_PROMOTION_CHECKS = [
  "identity-protocol-operations",
  "external-planning-20m",
  "question-continuation",
  "cancellation-process-cleanup",
  "subscription-auth-route",
  "claude-external-profile",
  "codex-external-profile",
  "cursor-external-profile",
  "session-resume",
  "event-result-normalization",
  "isolated-write",
  "daemon-restart-recovery",
  "malformed-output-unsupported-model",
  "artifact-diff-retrieval",
] as const;

interface InstallRecord {
  readonly schemaVersion: 1;
  readonly identity: RuntimeIdentity;
  readonly manifest: {
    readonly archiveUrl: string;
    readonly keyId: string;
  };
}

interface ActiveDescriptor {
  readonly schemaVersion: 1;
  readonly current: RuntimeIdentity | null;
  readonly previous: RuntimeIdentity | null;
  readonly currentReportId: string | null;
  readonly previousReportId: string | null;
}

interface ActivationRecord {
  readonly schemaVersion: 1;
  readonly activationId: string;
  readonly action: "activate" | "upgrade" | "rollback" | "adopt";
  readonly recordedAt: string;
  readonly activeBefore: RuntimeIdentity | null;
  readonly activeAfter: RuntimeIdentity;
  readonly compatibilityReportId: string;
}

interface OperationLockRecord {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly ownerToken: string;
  readonly acquiredAt: string;
}

interface ObservedOperationLock {
  readonly raw: string;
  readonly record: OperationLockRecord | null;
}

export interface RuntimeArchiveExtractor {
  extract(archivePath: string, destination: string): Promise<void>;
}

export type RuntimeFilesystemBoundary =
  | "install-archive-create"
  | "install-archive-write"
  | "install-archive-file-fsync"
  | "install-extraction"
  | "install-archive-unlink"
  | "install-record-create"
  | "install-record-write"
  | "install-record-file-fsync"
  | "install-record-directory-fsync"
  | "install-version-rename"
  | "install-version-directory-fsync"
  | "activation-attestation-create"
  | "activation-attestation-write"
  | "activation-attestation-file-fsync"
  | "activation-attestation-directory-fsync"
  | "activation-record-create"
  | "activation-record-write"
  | "activation-record-file-fsync"
  | "activation-record-directory-fsync"
  | "activation-descriptor-create"
  | "activation-descriptor-write"
  | "activation-descriptor-file-fsync"
  | "activation-descriptor-rename"
  | "activation-descriptor-directory-fsync";

export interface ClaudexorRuntimeManagerOptions {
  readonly home: Pick<ApplicationHome, "paths">;
  readonly gate: RuntimeCompatibilityGate;
  readonly probe: RuntimeIdentityProbe;
  readonly fetch?: typeof globalThis.fetch;
  readonly extractor?: RuntimeArchiveExtractor;
  readonly now?: () => Date;
  readonly nextId?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly maximumArchiveBytes?: number;
  readonly verifyManifest?: (value: unknown, expectedVersion: string) => ClaudexorRuntimeManifest;
  /** Injectable durability seam used to prove interruption safety without mutating global fs APIs. */
  readonly beforeFilesystemBoundary?: (boundary: RuntimeFilesystemBoundary) => void | Promise<void>;
}

export interface ClaudexorRuntimeManager {
  inventory(): Promise<RuntimeInventory>;
  install(version: string): Promise<RuntimeMutationResult>;
  activate(version: string): Promise<RuntimeMutationResult>;
  upgrade(version: string): Promise<RuntimeMutationResult>;
  rollback(): Promise<RuntimeMutationResult>;
  adopt(entryPath: string): Promise<RuntimeMutationResult>;
  resolveActive(): Promise<RuntimeIdentity | null>;
}

export interface ClaudexorRuntimeSelection {
  readonly identity: RuntimeIdentity;
  readonly entryPath: string;
  readonly expectedEngine: {
    readonly version: string;
    readonly buildSha: string;
  };
}

const DEFAULT_EXTRACTOR: RuntimeArchiveExtractor = {
  async extract(archivePath, destination) {
    await extractTar({
      file: archivePath,
      cwd: destination,
      strict: true,
      preservePaths: false,
    });
  },
};

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sameIdentity(left: RuntimeIdentity | null, right: RuntimeIdentity | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function errno(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function assertVersion(version: string): void {
  if (!SEMVER.test(version)) {
    throw new ClaudexorRuntimeError(
      "RELEASE_MANIFEST_INVALID",
      "A Claudexor runtime version must use x.y.z semantic versioning.",
    );
  }
}

function compareVersions(left: string, right: string): number {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (a === null || b === null) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readArchiveWithinLimit(
  response: Response,
  maximumArchiveBytes: number,
): Promise<Uint8Array> {
  if (response.body === null) {
    throw new ClaudexorRuntimeError(
      "ARCHIVE_INVALID",
      "The Claudexor runtime archive response has no body.",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumArchiveBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ClaudexorRuntimeError(
          "ARCHIVE_INVALID",
          "The Claudexor runtime archive is too large.",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const archive = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

interface NewJsonBoundaries {
  readonly create: RuntimeFilesystemBoundary;
  readonly write: RuntimeFilesystemBoundary;
  readonly fileSync: RuntimeFilesystemBoundary;
  readonly directorySync: RuntimeFilesystemBoundary;
}

interface AtomicJsonBoundaries extends NewJsonBoundaries {
  readonly rename: RuntimeFilesystemBoundary;
}

async function writeNewJsonWithBoundaries(
  path: string,
  value: unknown,
  boundaries: NewJsonBoundaries,
  before: (boundary: RuntimeFilesystemBoundary) => Promise<void>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await before(boundaries.create);
  const handle = await open(path, "wx", 0o600);
  try {
    await before(boundaries.write);
    await handle.writeFile(json(value), "utf8");
    await before(boundaries.fileSync);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await before(boundaries.directorySync);
  await syncDirectory(dirname(path));
}

async function writeJsonAtomicWithBoundaries(
  path: string,
  value: unknown,
  nextId: () => string,
  boundaries: AtomicJsonBoundaries,
  before: (boundary: RuntimeFilesystemBoundary) => Promise<void>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${ACTIVE_DESCRIPTOR_NAME}.${nextId()}.tmp`);
  await before(boundaries.create);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await before(boundaries.write);
    await handle.writeFile(json(value), "utf8");
    await before(boundaries.fileSync);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await before(boundaries.rename);
    await rename(temporary, path);
    await before(boundaries.directorySync);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

function operationLockFrom(value: unknown): OperationLockRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<OperationLockRecord>;
  return record.schemaVersion === 1 &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.ownerToken === "string" &&
    STAGING_ID.test(record.ownerToken) &&
    typeof record.acquiredAt === "string"
    ? (record as OperationLockRecord)
    : null;
}

function identityFrom(value: unknown): RuntimeIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaudexorRuntimeError(
      "RUNTIME_INTEGRITY_FAILED",
      "Runtime identity metadata is invalid.",
    );
  }
  const record = value as Partial<RuntimeIdentity>;
  if (
    record.schemaVersion !== 1 ||
    record.engine !== ENGINE ||
    (record.sourceMode !== "managed" && record.sourceMode !== "external") ||
    typeof record.entryPath !== "string" ||
    typeof record.version !== "string" ||
    !SEMVER.test(record.version) ||
    typeof record.buildSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(record.buildSha) ||
    typeof record.binarySha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.binarySha256) ||
    (record.archiveSha256 !== undefined && !/^[0-9a-f]{64}$/.test(record.archiveSha256))
  ) {
    throw new ClaudexorRuntimeError(
      "RUNTIME_INTEGRITY_FAILED",
      "Runtime identity metadata is invalid.",
    );
  }
  return record as RuntimeIdentity;
}

function descriptorFrom(value: unknown): ActiveDescriptor {
  if (value === null) {
    return {
      schemaVersion: 1,
      current: null,
      previous: null,
      currentReportId: null,
      previousReportId: null,
    };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ClaudexorRuntimeError(
      "RUNTIME_INTEGRITY_FAILED",
      "Active runtime metadata is invalid.",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    (record.currentReportId !== null &&
      (typeof record.currentReportId !== "string" || !SAFE_ID.test(record.currentReportId))) ||
    (record.previousReportId !== null &&
      (typeof record.previousReportId !== "string" || !SAFE_ID.test(record.previousReportId)))
  ) {
    throw new ClaudexorRuntimeError(
      "RUNTIME_INTEGRITY_FAILED",
      "Active runtime metadata is invalid.",
    );
  }
  return {
    schemaVersion: 1,
    current: record.current === null ? null : identityFrom(record.current),
    previous: record.previous === null ? null : identityFrom(record.previous),
    currentReportId: record.currentReportId as string | null,
    previousReportId: record.previousReportId as string | null,
  };
}

async function assertRuntimeFileIntegrity(identity: RuntimeIdentity): Promise<void> {
  try {
    const stats = await lstat(identity.entryPath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("not a regular file");
    if (sha256(await readFile(identity.entryPath)) !== identity.binarySha256) {
      throw new Error("digest changed");
    }
  } catch (error) {
    throw new ClaudexorRuntimeError(
      "RUNTIME_INTEGRITY_FAILED",
      "The selected Claudexor runtime entry is missing or its checksum changed.",
      { cause: error },
    );
  }
}

/** Read-only selection shared by daemon startup and doctor composition. */
export async function resolveClaudexorRuntimeSelection(
  home: Pick<ApplicationHome, "paths">,
): Promise<ClaudexorRuntimeSelection | null> {
  const descriptor = descriptorFrom(
    await readJson(join(home.paths.runtimesDirectory, ENGINE, ACTIVE_DESCRIPTOR_NAME)),
  );
  if (descriptor.current === null) return null;
  await assertRuntimeFileIntegrity(descriptor.current);
  return {
    identity: descriptor.current,
    entryPath: descriptor.current.entryPath,
    expectedEngine: {
      version: descriptor.current.version,
      buildSha: descriptor.current.buildSha,
    },
  };
}

export function createClaudexorRuntimeManager(
  options: ClaudexorRuntimeManagerOptions,
): ClaudexorRuntimeManager {
  const request = options.fetch ?? globalThis.fetch;
  const extractor = options.extractor ?? DEFAULT_EXTRACTOR;
  const now = options.now ?? (() => new Date());
  const nextId = options.nextId ?? randomUUID;
  const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  const maximumArchiveBytes = options.maximumArchiveBytes ?? 256 * 1024 * 1024;
  const verifyManifest = options.verifyManifest ?? parseAndVerifyRuntimeManifest;
  const beforeFilesystemBoundary = async (boundary: RuntimeFilesystemBoundary): Promise<void> => {
    await options.beforeFilesystemBoundary?.(boundary);
  };
  const providerRoot = join(options.home.paths.runtimesDirectory, ENGINE);
  const stagingRoot = join(providerRoot, ".staging");
  const attestationRoot = join(providerRoot, "attestations");
  const activationRoot = join(providerRoot, "activations");
  const descriptorPath = join(providerRoot, ACTIVE_DESCRIPTOR_NAME);
  const lockPath = join(providerRoot, LOCK_NAME);

  async function ensureRoots(): Promise<void> {
    await mkdir(providerRoot, { recursive: true, mode: 0o700 });
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await mkdir(attestationRoot, { recursive: true, mode: 0o700 });
    await mkdir(activationRoot, { recursive: true, mode: 0o700 });
  }

  async function cleanStaging(): Promise<void> {
    const entries = await readdir(stagingRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && STAGING_ID.test(entry.name)) {
        await rm(join(stagingRoot, entry.name), { recursive: true, force: true });
      }
    }
  }

  async function acquireLock(): Promise<() => Promise<void>> {
    await ensureRoots();
    async function observeLock(): Promise<ObservedOperationLock | null> {
      try {
        const raw = await readFile(lockPath, "utf8");
        let value: unknown = null;
        try {
          value = JSON.parse(raw) as unknown;
        } catch {
          // A crash between O_EXCL and the lock write is stale by definition.
        }
        return { raw, record: operationLockFrom(value) };
      } catch (error) {
        if (errno(error) === "ENOENT") return null;
        throw error;
      }
    }

    async function claimStaleLock(observed: ObservedOperationLock): Promise<boolean> {
      // Moving the exact observed file to a unique name is the ownership
      // transfer. A contender that loses the rename never unlinks lockPath,
      // so it cannot remove a successor's newly acquired lock.
      const claimedPath = join(providerRoot, `${LOCK_NAME}.stale-${randomUUID()}`);
      try {
        await rename(lockPath, claimedPath);
      } catch (error) {
        if (errno(error) === "ENOENT") return false;
        throw error;
      }
      const claimed = await readFile(claimedPath, "utf8");
      if (claimed !== observed.raw) {
        // The name changed after this contender observed it. Restore the
        // file only with a no-replace hard-link; this never overwrites a
        // successor's lock. If a successor already exists, leave its lock
        // untouched and let the caller report contention.
        try {
          await link(claimedPath, lockPath);
          await unlink(claimedPath);
        } catch (error) {
          if (errno(error) !== "EEXIST") throw error;
        }
        return false;
      }
      await unlink(claimedPath);
      return true;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let createdLock = false;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      const ownerToken = randomUUID();
      try {
        handle = await open(lockPath, "wx", 0o600);
        createdLock = true;
        await handle.writeFile(
          json({ schemaVersion: 1, pid: process.pid, ownerToken, acquiredAt: now().toISOString() }),
        );
        await handle.sync();
        await handle.close();
        handle = undefined;
        await syncDirectory(providerRoot);
        await cleanStaging();
        return async () => {
          const observed = await observeLock();
          if (observed?.record?.ownerToken === ownerToken) {
            await unlink(lockPath).catch((error: unknown) => {
              if (errno(error) !== "ENOENT") throw error;
            });
          }
          await syncDirectory(providerRoot);
        };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (createdLock) {
          const observed = await observeLock();
          if (observed?.record?.ownerToken === ownerToken) {
            await unlink(lockPath).catch(() => undefined);
          }
          await syncDirectory(providerRoot).catch(() => undefined);
        }
        if (errno(error) !== "EEXIST") throw error;
        const observed = await observeLock();
        if (observed === null) continue;
        if (observed.record === null || !isProcessAlive(observed.record.pid)) {
          if (await claimStaleLock(observed)) continue;
          continue;
        }
        if (attempt < 2) {
          // A live owner is never reclaimed. Retrying only covers the narrow
          // interval in which it releases the lock after our observation.
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        throw new ClaudexorRuntimeError(
          "RUNTIME_BUSY",
          "Another Claudexor runtime operation is already in progress.",
        );
      }
    }
    throw new ClaudexorRuntimeError(
      "RUNTIME_BUSY",
      "Unable to acquire the runtime operation lock.",
    );
  }

  async function withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const release = await acquireLock();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async function readDescriptor(): Promise<ActiveDescriptor> {
    return descriptorFrom(await readJson(descriptorPath));
  }

  async function digestFile(path: string): Promise<string> {
    return sha256(await readFile(path));
  }

  async function assertIntegrity(identity: RuntimeIdentity): Promise<void> {
    await assertRuntimeFileIntegrity(identity);
  }

  async function assertLiveIdentity(identity: RuntimeIdentity): Promise<void> {
    const observed = await options.probe.inspect(identity.entryPath);
    if (observed.version !== identity.version || observed.buildSha !== identity.buildSha) {
      throw new ClaudexorRuntimeError(
        "RUNTIME_INTEGRITY_FAILED",
        "The running Claudexor identity does not match the selected runtime record.",
      );
    }
  }

  function assertPassingReport(
    report: unknown,
    identity: RuntimeIdentity,
  ): asserts report is RuntimeCompatibilityReport {
    if (
      report === null ||
      typeof report !== "object" ||
      Array.isArray(report) ||
      !Array.isArray((report as Partial<RuntimeCompatibilityReport>).checks)
    ) {
      throw new ClaudexorRuntimeError(
        "COMPATIBILITY_BLOCKED",
        "The cached Claudexor compatibility attestation is missing or invalid.",
      );
    }
    const candidate = report as RuntimeCompatibilityReport;
    if (
      candidate.checks.some(
        (check) =>
          check === null ||
          typeof check !== "object" ||
          typeof check.name !== "string" ||
          !["pass", "fail", "blocked"].includes(check.status),
      )
    ) {
      throw new ClaudexorRuntimeError(
        "COMPATIBILITY_BLOCKED",
        "The cached Claudexor compatibility attestation is missing or invalid.",
      );
    }
    const statusByName = new Map(
      candidate.checks.map((check: RuntimeCompatibilityReport["checks"][number]) => [
        check.name,
        check.status,
      ]),
    );
    if (
      candidate.schemaVersion !== 1 ||
      candidate.suiteVersion !== CLAUDEXOR_PROMOTION_SUITE_VERSION ||
      candidate.status !== "pass" ||
      !sameIdentity(candidate.runtime, identity) ||
      !SAFE_ID.test(candidate.reportId) ||
      REQUIRED_PROMOTION_CHECKS.some((name) => statusByName.get(name) !== "pass")
    ) {
      throw new ClaudexorRuntimeError(
        "COMPATIBILITY_BLOCKED",
        "The Claudexor promotion suite did not pass every required compatibility check.",
      );
    }
  }

  async function installUnlocked(version: string): Promise<RuntimeMutationResult> {
    assertVersion(version);
    const before = (await readDescriptor()).current;
    const manifestResponse = await request(runtimeManifestUrl(version), {
      headers: { Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!manifestResponse.ok) {
      throw new ClaudexorRuntimeError(
        "RELEASE_MANIFEST_INVALID",
        "The requested Claudexor runtime manifest could not be downloaded.",
      );
    }
    const manifest = verifyManifest(await manifestResponse.json(), version);
    if (
      version === DEFAULT_CLAUDEXOR_VERSION &&
      (manifest.buildSha !== DEFAULT_CLAUDEXOR_BUILD_SHA ||
        manifest.sha256 !== DEFAULT_CLAUDEXOR_ARCHIVE_SHA256)
    ) {
      throw new ClaudexorRuntimeError(
        "RELEASE_MANIFEST_INVALID",
        "The bootstrap Claudexor release does not match Heniek's accepted pin.",
      );
    }
    const archiveResponse = await request(manifest.archiveUrl, {
      headers: { Accept: "application/gzip, application/octet-stream" },
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!archiveResponse.ok) {
      throw new ClaudexorRuntimeError(
        "ARCHIVE_INVALID",
        "The requested Claudexor runtime archive could not be downloaded.",
      );
    }
    const declaredLength = Number(archiveResponse.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumArchiveBytes) {
      throw new ClaudexorRuntimeError(
        "ARCHIVE_INVALID",
        "The Claudexor runtime archive is too large.",
      );
    }
    const archive = await readArchiveWithinLimit(archiveResponse, maximumArchiveBytes);
    if (sha256(archive) !== manifest.sha256) {
      throw new ClaudexorRuntimeError(
        "CHECKSUM_MISMATCH",
        "The Claudexor runtime archive checksum does not match its signed manifest.",
      );
    }

    const operationId = nextId();
    if (!STAGING_ID.test(operationId)) {
      throw new ClaudexorRuntimeError(
        "ARCHIVE_INVALID",
        "The runtime staging identifier is invalid.",
      );
    }
    const staging = join(stagingRoot, operationId);
    const archivePath = join(staging, manifest.archiveName);
    const finalRoot = join(providerRoot, version);
    const finalEntry = join(finalRoot, ENTRY_NAME);
    await mkdir(staging, { mode: 0o700 });
    try {
      await beforeFilesystemBoundary("install-archive-create");
      const archiveHandle = await open(archivePath, "wx", 0o600);
      try {
        await beforeFilesystemBoundary("install-archive-write");
        await archiveHandle.writeFile(archive);
        await beforeFilesystemBoundary("install-archive-file-fsync");
        await archiveHandle.sync();
      } finally {
        await archiveHandle.close();
      }
      try {
        await beforeFilesystemBoundary("install-extraction");
        await extractor.extract(archivePath, staging);
      } catch (error) {
        throw new ClaudexorRuntimeError(
          "ARCHIVE_INVALID",
          "The Claudexor runtime archive could not be extracted safely.",
          { cause: error },
        );
      }
      await beforeFilesystemBoundary("install-archive-unlink");
      await unlink(archivePath);
      const stagedEntry = join(staging, ENTRY_NAME);
      const stats = await lstat(stagedEntry);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new ClaudexorRuntimeError(
          "ARCHIVE_INVALID",
          "The Claudexor runtime archive has no safe daemon entry.",
        );
      }
      const identity: RuntimeIdentity = {
        schemaVersion: 1,
        engine: ENGINE,
        sourceMode: "managed",
        entryPath: finalEntry,
        version: manifest.version,
        buildSha: manifest.buildSha,
        binarySha256: await digestFile(stagedEntry),
        archiveSha256: manifest.sha256,
      };
      const installRecord: InstallRecord = {
        schemaVersion: 1,
        identity,
        manifest: { archiveUrl: manifest.archiveUrl, keyId: manifest.keyId },
      };
      await writeNewJsonWithBoundaries(
        join(staging, INSTALL_RECORD_NAME),
        installRecord,
        {
          create: "install-record-create",
          write: "install-record-write",
          fileSync: "install-record-file-fsync",
          directorySync: "install-record-directory-fsync",
        },
        beforeFilesystemBoundary,
      );
      try {
        await beforeFilesystemBoundary("install-version-rename");
        await rename(staging, finalRoot);
        await beforeFilesystemBoundary("install-version-directory-fsync");
        await syncDirectory(providerRoot);
      } catch (error) {
        if (errno(error) !== "EEXIST" && errno(error) !== "ENOTEMPTY") throw error;
        const existing = await readInstallRecord(finalRoot);
        await assertIntegrity(existing.identity);
        if (!sameIdentity(existing.identity, identity)) {
          throw new ClaudexorRuntimeError(
            "INSTALL_CONFLICT",
            "A different Claudexor runtime is already installed for this version.",
          );
        }
        await rm(staging, { recursive: true, force: true });
        return {
          schemaVersion: 1,
          action: "install",
          activeBefore: before,
          activeAfter: before,
          runtime: existing.identity,
        };
      }
      return {
        schemaVersion: 1,
        action: "install",
        activeBefore: before,
        activeAfter: before,
        runtime: identity,
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async function readInstallRecord(root: string): Promise<InstallRecord> {
    const value = await readJson(join(root, INSTALL_RECORD_NAME));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ClaudexorRuntimeError(
        "RUNTIME_NOT_INSTALLED",
        "The requested managed Claudexor runtime is not installed.",
      );
    }
    const record = value as Record<string, unknown>;
    return {
      schemaVersion: 1,
      identity: identityFrom(record.identity),
      manifest: record.manifest as InstallRecord["manifest"],
    };
  }

  async function recordActivation(
    descriptor: ActiveDescriptor,
    identity: RuntimeIdentity,
    report: RuntimeCompatibilityReport,
    action: ActivationRecord["action"],
  ): Promise<RuntimeMutationResult> {
    assertPassingReport(report, identity);
    await writeNewJsonWithBoundaries(
      join(attestationRoot, `${report.reportId}.json`),
      report,
      {
        create: "activation-attestation-create",
        write: "activation-attestation-write",
        fileSync: "activation-attestation-file-fsync",
        directorySync: "activation-attestation-directory-fsync",
      },
      beforeFilesystemBoundary,
    ).catch(async (error: unknown) => {
      if (errno(error) !== "EEXIST") throw error;
      const existing = await readJson(join(attestationRoot, `${report.reportId}.json`));
      if (JSON.stringify(existing) !== JSON.stringify(report)) throw error;
    });
    const activationId = nextId();
    if (!SAFE_ID.test(activationId)) {
      throw new ClaudexorRuntimeError(
        "ACTIVATION_WRITE_FAILED",
        "Activation identifier is invalid.",
      );
    }
    const activation: ActivationRecord = {
      schemaVersion: 1,
      activationId,
      action,
      recordedAt: now().toISOString(),
      activeBefore: descriptor.current,
      activeAfter: identity,
      compatibilityReportId: report.reportId,
    };
    await writeNewJsonWithBoundaries(
      join(activationRoot, `${activationId}.json`),
      activation,
      {
        create: "activation-record-create",
        write: "activation-record-write",
        fileSync: "activation-record-file-fsync",
        directorySync: "activation-record-directory-fsync",
      },
      beforeFilesystemBoundary,
    );
    const nextDescriptor: ActiveDescriptor = {
      schemaVersion: 1,
      current: identity,
      previous: descriptor.current,
      currentReportId: report.reportId,
      previousReportId: descriptor.currentReportId,
    };
    try {
      await writeJsonAtomicWithBoundaries(
        descriptorPath,
        nextDescriptor,
        nextId,
        {
          create: "activation-descriptor-create",
          write: "activation-descriptor-write",
          fileSync: "activation-descriptor-file-fsync",
          rename: "activation-descriptor-rename",
          directorySync: "activation-descriptor-directory-fsync",
        },
        beforeFilesystemBoundary,
      );
    } catch (error) {
      throw new ClaudexorRuntimeError(
        "ACTIVATION_WRITE_FAILED",
        "The active Claudexor runtime could not be changed atomically.",
        { cause: error },
      );
    }
    return {
      schemaVersion: 1,
      action,
      activeBefore: descriptor.current,
      activeAfter: identity,
      runtime: identity,
      compatibilityReportId: report.reportId,
    };
  }

  async function promoteUnlocked(
    identity: RuntimeIdentity,
    action: "activate" | "upgrade" | "adopt",
  ): Promise<RuntimeMutationResult> {
    await assertIntegrity(identity);
    await assertLiveIdentity(identity);
    const report = await options.gate.run(identity);
    return recordActivation(await readDescriptor(), identity, report, action);
  }

  async function inventory(): Promise<RuntimeInventory> {
    const descriptor = await readDescriptor();
    const installed: RuntimeIdentity[] = [];
    try {
      const entries = await readdir(providerRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && SEMVER.test(entry.name)) {
          try {
            installed.push((await readInstallRecord(join(providerRoot, entry.name))).identity);
          } catch {
            // Invalid/incomplete directories are never advertised as installed.
          }
        }
      }
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
    installed.sort((a, b) => compareVersions(a.version, b.version));
    return {
      schemaVersion: 1,
      active: descriptor.current,
      previous: descriptor.previous,
      installed,
    };
  }

  return {
    inventory,

    install(version) {
      return withMutation(() => installUnlocked(version));
    },

    activate(version) {
      return withMutation(async () => {
        assertVersion(version);
        const record = await readInstallRecord(join(providerRoot, version));
        return promoteUnlocked(record.identity, "activate");
      });
    },

    upgrade(version) {
      return withMutation(async () => {
        const descriptor = await readDescriptor();
        if (
          descriptor.current !== null &&
          compareVersions(version, descriptor.current.version) <= 0
        ) {
          throw new ClaudexorRuntimeError(
            "RELEASE_MANIFEST_INVALID",
            "An upgrade target must be newer than the active Claudexor version.",
          );
        }
        const installed = await installUnlocked(version);
        if (installed.runtime === undefined) {
          throw new ClaudexorRuntimeError(
            "RUNTIME_NOT_INSTALLED",
            "The upgrade runtime was not installed.",
          );
        }
        return promoteUnlocked(installed.runtime, "upgrade");
      });
    },

    rollback() {
      return withMutation(async () => {
        const descriptor = await readDescriptor();
        if (descriptor.previous === null || descriptor.previousReportId === null) {
          throw new ClaudexorRuntimeError(
            "NO_ROLLBACK_TARGET",
            "No previously promoted Claudexor runtime is available for rollback.",
          );
        }
        await assertIntegrity(descriptor.previous);
        await assertLiveIdentity(descriptor.previous);
        const reportValue = await readJson(
          join(attestationRoot, `${descriptor.previousReportId}.json`),
        );
        assertPassingReport(reportValue, descriptor.previous);
        const activationId = nextId();
        if (!SAFE_ID.test(activationId)) {
          throw new ClaudexorRuntimeError(
            "ACTIVATION_WRITE_FAILED",
            "Activation identifier is invalid.",
          );
        }
        const activation: ActivationRecord = {
          schemaVersion: 1,
          activationId,
          action: "rollback",
          recordedAt: now().toISOString(),
          activeBefore: descriptor.current,
          activeAfter: descriptor.previous,
          compatibilityReportId: descriptor.previousReportId,
        };
        await writeNewJsonWithBoundaries(
          join(activationRoot, `${activationId}.json`),
          activation,
          {
            create: "activation-record-create",
            write: "activation-record-write",
            fileSync: "activation-record-file-fsync",
            directorySync: "activation-record-directory-fsync",
          },
          beforeFilesystemBoundary,
        );
        const nextDescriptor: ActiveDescriptor = {
          schemaVersion: 1,
          current: descriptor.previous,
          previous: descriptor.current,
          currentReportId: descriptor.previousReportId,
          previousReportId: descriptor.currentReportId,
        };
        try {
          await writeJsonAtomicWithBoundaries(
            descriptorPath,
            nextDescriptor,
            nextId,
            {
              create: "activation-descriptor-create",
              write: "activation-descriptor-write",
              fileSync: "activation-descriptor-file-fsync",
              rename: "activation-descriptor-rename",
              directorySync: "activation-descriptor-directory-fsync",
            },
            beforeFilesystemBoundary,
          );
        } catch (error) {
          throw new ClaudexorRuntimeError(
            "ACTIVATION_WRITE_FAILED",
            "The active Claudexor runtime could not be rolled back atomically.",
            { cause: error },
          );
        }
        return {
          schemaVersion: 1,
          action: "rollback",
          activeBefore: descriptor.current,
          activeAfter: descriptor.previous,
          runtime: descriptor.previous,
          compatibilityReportId: descriptor.previousReportId,
        };
      });
    },

    adopt(entryPath) {
      return withMutation(async () => {
        if (!entryPath.startsWith("/")) {
          throw new ClaudexorRuntimeError(
            "EXTERNAL_RUNTIME_INVALID",
            "An external Claudexor runtime entry must be an absolute path.",
          );
        }
        let canonical: string;
        try {
          canonical = await realpath(resolve(entryPath));
          const stats = await lstat(canonical);
          if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("not a regular file");
        } catch (error) {
          throw new ClaudexorRuntimeError(
            "EXTERNAL_RUNTIME_INVALID",
            "The external Claudexor runtime entry is not a readable regular file.",
            { cause: error },
          );
        }
        const observed = await options.probe.inspect(canonical);
        const identity: RuntimeIdentity = {
          schemaVersion: 1,
          engine: ENGINE,
          sourceMode: "external",
          entryPath: canonical,
          version: observed.version,
          buildSha: observed.buildSha,
          binarySha256: await digestFile(canonical),
        };
        return promoteUnlocked(identity, "adopt");
      });
    },

    async resolveActive() {
      return (await resolveClaudexorRuntimeSelection(options.home))?.identity ?? null;
    },
  };
}
