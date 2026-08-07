import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApplicationHome } from "@heniek/config";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudexorRuntimeError,
  createClaudexorRuntimeManager,
  REQUIRED_PROMOTION_CHECKS,
  type RuntimeCompatibilityGate,
  type RuntimeFilesystemBoundary,
  type RuntimeIdentity,
  type RuntimeIdentityProbe,
} from "../src/index.js";
import {
  type ClaudexorRuntimeManifest,
  runtimeArchiveName,
  runtimeArchiveUrl,
  sha256,
} from "../src/release.js";

const roots: string[] = [];
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const INSTALL_BOUNDARIES: readonly RuntimeFilesystemBoundary[] = [
  "install-archive-create",
  "install-archive-write",
  "install-archive-file-fsync",
  "install-extraction",
  "install-archive-unlink",
  "install-record-create",
  "install-record-write",
  "install-record-file-fsync",
  "install-record-directory-fsync",
  "install-version-rename",
  "install-version-directory-fsync",
];
const ACTIVATION_BOUNDARIES: readonly RuntimeFilesystemBoundary[] = [
  "activation-attestation-create",
  "activation-attestation-write",
  "activation-attestation-file-fsync",
  "activation-attestation-directory-fsync",
  "activation-record-create",
  "activation-record-write",
  "activation-record-file-fsync",
  "activation-record-directory-fsync",
  "activation-descriptor-create",
  "activation-descriptor-write",
  "activation-descriptor-file-fsync",
  "activation-descriptor-rename",
  "activation-descriptor-directory-fsync",
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function report(identity: RuntimeIdentity, reportId: string) {
  return {
    schemaVersion: 1 as const,
    reportId,
    runtime: identity,
    suiteVersion: 1,
    status: "pass" as const,
    checks: REQUIRED_PROMOTION_CHECKS.map((name) => ({
      name,
      status: "pass" as const,
      message: `${name} passed.`,
    })),
    completedAt: "2026-08-07T10:00:00.000Z",
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "heniek-runtime-manager-"));
  roots.push(root);
  const home = resolveApplicationHome({
    env: { HENIEK_HOME: root },
    homeDirectory: root,
    platform: "linux",
  });
  let archive = Buffer.from("archive-a");
  let binary = "binary-a";
  let gateStatus: "pass" | "fail" = "pass";
  let extractionFails = false;
  let failingBoundary: RuntimeFilesystemBoundary | undefined;
  let reportNumber = 0;
  let manifestBarrier:
    | {
        readonly entered: () => void;
        readonly wait: Promise<void>;
      }
    | undefined;
  const identities = new Map<string, { version: string; buildSha: string }>();

  function buildSha(version: string): string {
    return version === "3.1.3" ? SHA_A : SHA_B;
  }

  function manifest(version: string): ClaudexorRuntimeManifest {
    return {
      schemaVersion: 1,
      version,
      sha256: sha256(archive),
      minAppVersion: "2.1.0",
      archiveName: runtimeArchiveName(version),
      archiveUrl: runtimeArchiveUrl(version),
      buildSha: buildSha(version),
      notes: "test",
      keyId: "test-key",
      algorithm: "Ed25519",
      signature: "test",
    };
  }

  const probe: RuntimeIdentityProbe = {
    async inspect(entryPath) {
      const explicit = identities.get(entryPath);
      if (explicit !== undefined) return explicit;
      const version = entryPath.includes("3.1.4") ? "3.1.4" : "3.1.3";
      return { version, buildSha: buildSha(version) };
    },
  };
  const gate: RuntimeCompatibilityGate = {
    async run(identity) {
      const passing = report(identity, `report-${++reportNumber}`);
      return gateStatus === "pass"
        ? passing
        : {
            ...passing,
            status: "fail",
            checks: passing.checks.map((check, index) =>
              index === 0 ? { ...check, status: "fail" as const } : check,
            ),
          };
    },
  };
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    const match = /download\/v([^/]+)\//.exec(url);
    const version = match?.[1] ?? "3.1.3";
    if (url.endsWith("runtime-manifest.json")) {
      manifestBarrier?.entered();
      await manifestBarrier?.wait;
      return Response.json(manifest(version));
    }
    return new Response(archive, {
      headers: { "content-length": String(archive.byteLength) },
    });
  };
  const extractor = {
    async extract(_archivePath: string, destination: string) {
      await writeFile(join(destination, "claudexord.bundle.cjs"), binary, "utf8");
      if (extractionFails) throw new Error("injected extraction interruption");
    },
  };
  const manager = createClaudexorRuntimeManager({
    home,
    fetch,
    extractor,
    probe,
    gate,
    verifyManifest: (value) => value as ClaudexorRuntimeManifest,
    now: () => new Date("2026-08-07T10:00:00.000Z"),
    beforeFilesystemBoundary(boundary) {
      if (boundary === failingBoundary) throw new Error(`injected ${boundary}`);
    },
  });
  return {
    root,
    home,
    manager,
    setArchive(value: string) {
      archive = Buffer.from(value);
    },
    setBinary(value: string) {
      binary = value;
    },
    setGateStatus(value: "pass" | "fail") {
      gateStatus = value;
    },
    setExtractionFails(value: boolean) {
      extractionFails = value;
    },
    failAt(boundary: RuntimeFilesystemBoundary | undefined) {
      failingBoundary = boundary;
    },
    blockManifest() {
      let releaseWait: () => void = () => {};
      let entered: () => void = () => {};
      const wait = new Promise<void>((resolve) => {
        releaseWait = resolve;
      });
      const observed = new Promise<void>((resolve) => {
        entered = resolve;
      });
      manifestBarrier = { entered, wait };
      return {
        observed,
        release() {
          manifestBarrier = undefined;
          releaseWait();
        },
      };
    },
    setProbe(path: string, version: string, buildShaValue: string) {
      identities.set(path, { version, buildSha: buildShaValue });
    },
  };
}

describe("managed Claudexor runtime lifecycle", () => {
  it("installs side by side without activation and makes identical reinstall idempotent", async () => {
    const setup = await fixture();
    const first = await setup.manager.install("3.1.3");
    expect(first.activeAfter).toBeNull();
    expect(first.runtime?.archiveSha256).toHaveLength(64);
    expect(first.runtime?.binarySha256).toBe(createHash("sha256").update("binary-a").digest("hex"));

    const second = await setup.manager.install("3.1.3");
    expect(second.runtime).toEqual(first.runtime);
    expect(await setup.manager.inventory()).toMatchObject({
      active: null,
      previous: null,
      installed: [first.runtime],
    });
  });

  it("rejects a checksum mismatch and removes interrupted staging", async () => {
    const setup = await fixture();
    const manager = createClaudexorRuntimeManager({
      home: setup.home,
      fetch: async (input) =>
        String(input).endsWith("runtime-manifest.json")
          ? Response.json({
              schemaVersion: 1,
              version: "3.1.3",
              sha256: "0".repeat(64),
              minAppVersion: "2.1.0",
              archiveName: runtimeArchiveName("3.1.3"),
              archiveUrl: runtimeArchiveUrl("3.1.3"),
              buildSha: SHA_A,
              notes: "test",
              keyId: "test",
              algorithm: "Ed25519",
              signature: "test",
            })
          : new Response("not-the-declared-archive"),
      extractor: { async extract() {} },
      probe: {
        async inspect() {
          return { version: "3.1.3", buildSha: SHA_A };
        },
      },
      gate: {
        async run(identity) {
          return report(identity, "unused");
        },
      },
      verifyManifest: (value) => value as ClaudexorRuntimeManifest,
    });
    await expect(manager.install("3.1.3")).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect((await manager.inventory()).installed).toEqual([]);
  });

  it("cancels an archive stream as soon as it exceeds the configured limit", async () => {
    const setup = await fixture();
    let cancelled = false;
    let chunk = 0;
    const manager = createClaudexorRuntimeManager({
      home: setup.home,
      maximumArchiveBytes: 4,
      fetch: async (input) => {
        if (String(input).endsWith("runtime-manifest.json")) {
          return Response.json({
            schemaVersion: 1,
            version: "3.1.3",
            sha256: "a".repeat(64),
            minAppVersion: "2.1.0",
            archiveName: runtimeArchiveName("3.1.3"),
            archiveUrl: runtimeArchiveUrl("3.1.3"),
            buildSha: SHA_A,
            notes: "test",
            keyId: "test",
            algorithm: "Ed25519",
            signature: "test",
          });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              chunk += 1;
              controller.enqueue(new Uint8Array([chunk, chunk, chunk]));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
      extractor: { async extract() {} },
      probe: {
        async inspect() {
          return { version: "3.1.3", buildSha: SHA_A };
        },
      },
      gate: {
        async run(identity) {
          return report(identity, "unused");
        },
      },
      verifyManifest: (value) => value as ClaudexorRuntimeManifest,
    });
    await expect(manager.install("3.1.3")).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
    expect(cancelled).toBe(true);
  });

  it("detects conflicting contents for an installed version", async () => {
    const setup = await fixture();
    await setup.manager.install("3.1.3");
    setup.setArchive("archive-b");
    setup.setBinary("binary-b");
    await expect(setup.manager.install("3.1.3")).rejects.toMatchObject({
      code: "INSTALL_CONFLICT",
    });
  });

  it("recovers after an interrupted extraction without advertising a partial install", async () => {
    const setup = await fixture();
    setup.setExtractionFails(true);
    await expect(setup.manager.install("3.1.3")).rejects.toMatchObject({
      code: "ARCHIVE_INVALID",
    });
    expect((await setup.manager.inventory()).installed).toEqual([]);
    setup.setExtractionFails(false);
    await expect(setup.manager.install("3.1.3")).resolves.toMatchObject({ action: "install" });
  });

  it.each(INSTALL_BOUNDARIES)(
    "preserves the active runtime when install is interrupted at %s",
    async (boundary) => {
      const setup = await fixture();
      await setup.manager.install("3.1.3");
      const active = await setup.manager.activate("3.1.3");
      setup.setArchive("archive-b");
      setup.setBinary("binary-b");
      setup.failAt(boundary);

      await expect(setup.manager.install("3.1.4")).rejects.toThrow();
      const inventory = await setup.manager.inventory();
      expect(inventory.active).toEqual(active.runtime);
      await expect(setup.manager.resolveActive()).resolves.toEqual(active.runtime);
    },
  );

  it("serializes concurrent mutations with a stable busy error", async () => {
    const setup = await fixture();
    const barrier = setup.blockManifest();
    const first = setup.manager.install("3.1.3");
    await barrier.observed;
    await expect(setup.manager.install("3.1.3")).rejects.toMatchObject({
      code: "RUNTIME_BUSY",
    });
    barrier.release();
    await expect(first).resolves.toMatchObject({ action: "install" });
  });

  it("recovers a malformed crash lock instead of remaining permanently busy", async () => {
    const setup = await fixture();
    const providerRoot = join(setup.home.paths.runtimesDirectory, "claudexor");
    await mkdir(providerRoot, { recursive: true });
    await writeFile(join(providerRoot, ".operation.lock"), "{incomplete", "utf8");

    await expect(setup.manager.install("3.1.3")).resolves.toMatchObject({ action: "install" });
  });

  it("lets only one recoverer replace a stale lock", async () => {
    const setup = await fixture();
    const providerRoot = join(setup.home.paths.runtimesDirectory, "claudexor");
    await mkdir(providerRoot, { recursive: true });
    await writeFile(
      join(providerRoot, ".operation.lock"),
      JSON.stringify({
        schemaVersion: 1,
        pid: 999_999,
        ownerToken: "00000000-0000-4000-8000-000000000000",
        acquiredAt: "2026-08-07T10:00:00.000Z",
      }),
      "utf8",
    );
    const barrier = setup.blockManifest();
    const first = setup.manager.install("3.1.3");
    await barrier.observed;

    await expect(setup.manager.install("3.1.3")).rejects.toMatchObject({ code: "RUNTIME_BUSY" });
    barrier.release();
    await expect(first).resolves.toMatchObject({ action: "install" });
  });

  it("preserves the active descriptor when a candidate promotion fails", async () => {
    const setup = await fixture();
    await setup.manager.install("3.1.3");
    const active = await setup.manager.activate("3.1.3");
    setup.setArchive("archive-b");
    setup.setBinary("binary-b");
    await setup.manager.install("3.1.4");
    setup.setGateStatus("fail");
    await expect(setup.manager.activate("3.1.4")).rejects.toMatchObject({
      code: "COMPATIBILITY_BLOCKED",
    });
    expect((await setup.manager.inventory()).active).toEqual(active.runtime);
  });

  it.each(ACTIVATION_BOUNDARIES)(
    "keeps the prior runtime recoverable when activation is interrupted at %s",
    async (boundary) => {
      const setup = await fixture();
      await setup.manager.install("3.1.3");
      const prior = await setup.manager.activate("3.1.3");
      setup.setArchive("archive-b");
      setup.setBinary("binary-b");
      await setup.manager.install("3.1.4");
      setup.failAt(boundary);

      await expect(setup.manager.activate("3.1.4")).rejects.toThrow();
      const inventory = await setup.manager.inventory();
      if (boundary === "activation-descriptor-directory-fsync") {
        expect(inventory.active?.version).toBe("3.1.4");
        expect(inventory.previous).toEqual(prior.runtime);
      } else {
        expect(inventory.active).toEqual(prior.runtime);
      }
      if (prior.runtime === undefined) throw new Error("missing prior runtime");
      await expect(readFile(prior.runtime.entryPath, "utf8")).resolves.toBe("binary-a");
    },
  );

  it("refuses non-monotonic upgrades before downloading or changing the active runtime", async () => {
    const setup = await fixture();
    await setup.manager.install("3.1.3");
    const active = await setup.manager.activate("3.1.3");

    await expect(setup.manager.upgrade("3.1.3")).rejects.toMatchObject({
      code: "RELEASE_MANIFEST_INVALID",
    });
    await expect(setup.manager.upgrade("3.1.2")).rejects.toMatchObject({
      code: "RELEASE_MANIFEST_INVALID",
    });
    expect((await setup.manager.inventory()).active).toEqual(active.runtime);
  });

  it("rolls back using the immutable attestation and refuses a changed prior binary", async () => {
    const setup = await fixture();
    await setup.manager.install("3.1.3");
    const first = await setup.manager.activate("3.1.3");
    setup.setArchive("archive-b");
    setup.setBinary("binary-b");
    await setup.manager.install("3.1.4");
    await setup.manager.activate("3.1.4");
    expect((await setup.manager.rollback()).activeAfter).toEqual(first.runtime);

    await setup.manager.rollback();
    const previous = (await setup.manager.inventory()).previous;
    if (previous === null) throw new Error("missing rollback target");
    await writeFile(previous.entryPath, "mutated", "utf8");
    const before = (await setup.manager.inventory()).active;
    await expect(setup.manager.rollback()).rejects.toMatchObject({
      code: "RUNTIME_INTEGRITY_FAILED",
    });
    expect((await setup.manager.inventory()).active).toEqual(before);
  });

  it("refuses rollback when the selected immutable attestation is missing", async () => {
    const setup = await fixture();
    await setup.manager.install("3.1.3");
    await setup.manager.activate("3.1.3");
    setup.setArchive("archive-b");
    setup.setBinary("binary-b");
    await setup.manager.install("3.1.4");
    const active = await setup.manager.activate("3.1.4");
    await rm(
      join(setup.home.paths.runtimesDirectory, "claudexor", "attestations", "report-1.json"),
    );

    await expect(setup.manager.rollback()).rejects.toMatchObject({
      code: "COMPATIBILITY_BLOCKED",
    });
    expect((await setup.manager.inventory()).active).toEqual(active.runtime);
  });

  it("canonicalizes an external entry, promotes it, and detects later disappearance", async () => {
    const setup = await fixture();
    const externalRoot = join(setup.root, "external");
    const entry = join(externalRoot, "daemon.cjs");
    await mkdir(externalRoot, { recursive: true });
    await writeFile(entry, "external", "utf8");
    const canonicalEntry = await realpath(entry);
    setup.setProbe(canonicalEntry, "3.2.0", "c".repeat(40));
    const adopted = await setup.manager.adopt(entry);
    expect(adopted.runtime).toMatchObject({
      sourceMode: "external",
      entryPath: canonicalEntry,
      version: "3.2.0",
    });
    await rm(entry);
    await expect(setup.manager.resolveActive()).rejects.toMatchObject({
      code: "RUNTIME_INTEGRITY_FAILED",
    });
  });

  it("recovers a dead operation lock and cleans only validated stale staging entries", async () => {
    const setup = await fixture();
    const providerRoot = join(setup.home.paths.runtimesDirectory, "claudexor");
    const stagingRoot = join(providerRoot, ".staging");
    await mkdir(join(stagingRoot, "11111111-1111-4111-8111-111111111111"), {
      recursive: true,
    });
    await mkdir(join(stagingRoot, "do-not-clean"), { recursive: true });
    await writeFile(
      join(providerRoot, ".operation.lock"),
      JSON.stringify({ schemaVersion: 1, pid: 999_999_999 }),
      "utf8",
    );
    const manager = createClaudexorRuntimeManager({
      home: setup.home,
      fetch: async (input) => {
        const version = "3.1.3";
        const bytes = Buffer.from("archive");
        return String(input).endsWith("runtime-manifest.json")
          ? Response.json({
              schemaVersion: 1,
              version,
              sha256: sha256(bytes),
              minAppVersion: "2.1.0",
              archiveName: runtimeArchiveName(version),
              archiveUrl: runtimeArchiveUrl(version),
              buildSha: SHA_A,
              notes: "test",
              keyId: "test",
              algorithm: "Ed25519",
              signature: "test",
            })
          : new Response(bytes);
      },
      extractor: {
        async extract(_archivePath, destination) {
          await writeFile(join(destination, "claudexord.bundle.cjs"), "binary", "utf8");
        },
      },
      probe: {
        async inspect() {
          return { version: "3.1.3", buildSha: SHA_A };
        },
      },
      gate: {
        async run(identity) {
          return report(identity, "report");
        },
      },
      verifyManifest: (value) => value as ClaudexorRuntimeManifest,
      isProcessAlive: () => false,
    });
    await manager.install("3.1.3");
    expect(await readdir(stagingRoot)).toEqual(["do-not-clean"]);
    expect(await readFile(join(providerRoot, "3.1.3/claudexord.bundle.cjs"), "utf8")).toBe(
      "binary",
    );
  });

  it("rejects an archive whose daemon entry is a symbolic link", async () => {
    const setup = await fixture();
    const manager = createClaudexorRuntimeManager({
      home: setup.home,
      fetch: async (input) => {
        const bytes = Buffer.from("archive");
        return String(input).endsWith("runtime-manifest.json")
          ? Response.json({
              schemaVersion: 1,
              version: "3.1.3",
              sha256: sha256(bytes),
              minAppVersion: "2.1.0",
              archiveName: runtimeArchiveName("3.1.3"),
              archiveUrl: runtimeArchiveUrl("3.1.3"),
              buildSha: SHA_A,
              notes: "test",
              keyId: "test",
              algorithm: "Ed25519",
              signature: "test",
            })
          : new Response(bytes);
      },
      extractor: {
        async extract(_archivePath, destination) {
          const target = join(destination, "target.cjs");
          await writeFile(target, "binary", "utf8");
          await symlink(target, join(destination, "claudexord.bundle.cjs"));
        },
      },
      probe: {
        async inspect() {
          return { version: "3.1.3", buildSha: SHA_A };
        },
      },
      gate: {
        async run(identity) {
          return report(identity, "report");
        },
      },
      verifyManifest: (value) => value as ClaudexorRuntimeManifest,
    });
    await expect(manager.install("3.1.3")).rejects.toBeInstanceOf(ClaudexorRuntimeError);
    expect((await manager.inventory()).installed).toEqual([]);
  });
});
