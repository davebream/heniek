import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CombinedVerificationReport,
  RepositoryId,
  VerifyCheckV1,
  WorkspaceId,
  WorkspaceRecoveryPhase,
  WorkspaceVariantId,
} from "@heniek/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCompositeLifecycleService,
  type LifecycleEvidenceArchive,
  type RecoveryPhaseObservation,
  type VerificationCommandExecutor,
} from "../src/index.js";

const roots: string[] = [];
const now = "2026-08-12T12:00:00.000Z";
const workspaceId = "workspace-q038" as WorkspaceId;
const variantId = "variant-q038" as WorkspaceVariantId;
const phases = [
  "provisioning",
  "setup",
  "leases",
  "processes",
  "artifacts",
  "integration-refs",
] as const satisfies readonly WorkspaceRecoveryPhase[];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function check(checkId: string): VerifyCheckV1 {
  return {
    schemaVersion: 1,
    checkId,
    argv: ["fixture", checkId],
    expectedExitCode: 0,
    required: true,
  };
}

function observations(): RecoveryPhaseObservation[] {
  return phases.map((phase) => ({
    phase,
    state: "complete",
    ownership: "heniek",
    resumeSafe: false,
    retrySafe: false,
    detail: `${phase} evidence is complete`,
  }));
}

function verification(): CombinedVerificationReport {
  return {
    schemaVersion: 1,
    reportId: "q038-cleanup-verification",
    workspaceId,
    variantId,
    classification: "passed",
    checks: [
      {
        checkId: "combined",
        scope: "whole-codebase",
        repositoryId: null,
        argv: ["pnpm", "check"],
        cwd: "/workspace",
        expectedExitCode: 0,
        actualExitCode: 0,
        required: true,
        outcome: "passed",
        logPath: "/evidence/pnpm-check.log",
        logSha256: "b".repeat(64),
        startedAt: now,
        finishedAt: now,
      },
    ],
    failedRepositoryIds: [],
    wholeCodebaseFailed: false,
    startedAt: now,
    finishedAt: now,
  };
}

function memoryArchive(events: string[] = []): LifecycleEvidenceArchive {
  return {
    async archive() {
      events.push("archive");
      return { path: "/evidence/q038.json", sha256: "a".repeat(64) };
    },
  };
}

describe("Q038 combined verification", () => {
  it("fans in every repository and whole-Codebase result without hiding local failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-q038-verify-"));
    roots.push(root);
    const api = join(root, "api");
    const web = join(root, "web");
    await Promise.all([mkdir(api), mkdir(web)]);
    const executed: string[] = [];
    const executor: VerificationCommandExecutor = {
      async run(input) {
        const checkId = input.argv[1] ?? "missing";
        executed.push(checkId);
        return {
          exitCode: checkId === "api-test" ? 1 : 0,
          timedOut: false,
          output: `${checkId} output\n`,
        };
      },
    };
    const service = createCompositeLifecycleService({
      logsDirectory: join(root, "logs"),
      archive: memoryArchive(),
      clock: { nowIso: () => now },
      executor,
    });

    const report = await service.verify({
      reportId: "q038-fan-in",
      workspaceId,
      variantId,
      repositories: [
        {
          repositoryId: "repo-api" as RepositoryId,
          checkoutPath: api,
          checks: [check("api-test")],
        },
        {
          repositoryId: "repo-web" as RepositoryId,
          checkoutPath: web,
          checks: [check("web-test")],
        },
      ],
      wholeCodebaseChecks: [{ cwd: root, check: check("composite-test") }],
    });

    expect(executed.sort()).toEqual(["api-test", "composite-test", "web-test"]);
    expect(report.classification).toBe("failed");
    expect(report.checks).toHaveLength(3);
    expect(report.failedRepositoryIds).toEqual(["repo-api"]);
    expect(report.wholeCodebaseFailed).toBe(false);
    expect(report.checks.find((entry) => entry.checkId === "web-test")?.outcome).toBe("passed");
    expect(report.checks.find((entry) => entry.checkId === "composite-test")?.outcome).toBe(
      "passed",
    );
  });

  it("rejects a repository-relative cwd that escapes its checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-q038-cwd-"));
    roots.push(root);
    const service = createCompositeLifecycleService({
      logsDirectory: join(root, "logs"),
      archive: memoryArchive(),
      clock: { nowIso: () => now },
    });
    await expect(
      service.verify({
        reportId: "q038-escape",
        workspaceId,
        variantId,
        repositories: [
          {
            repositoryId: "repo-api" as RepositoryId,
            checkoutPath: root,
            checks: [{ ...check("escape"), cwd: "../outside" }],
          },
        ],
        wholeCodebaseChecks: [{ cwd: root, check: check("composite") }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
  });
});

describe("Q038 restart reconciliation and cleanup", () => {
  it.each(phases)(
    "preserves a checkout when restart evidence is ambiguous at %s",
    async (phase) => {
      const root = await mkdtemp(join(tmpdir(), `heniek-q038-${phase}-`));
      roots.push(root);
      const variantRoot = join(root, "variants", phase);
      await mkdir(variantRoot, { recursive: true });
      const removed: string[] = [];
      const service = createCompositeLifecycleService({
        logsDirectory: join(root, "logs"),
        archive: memoryArchive(),
        clock: { nowIso: () => now },
        removeCheckout: async (path) => {
          removed.push(path);
        },
      });
      const killed = observations().map((entry) =>
        entry.phase === phase
          ? {
              ...entry,
              state: "ambiguous" as const,
              ownership: "unknown" as const,
              detail: `daemon killed during ${phase}`,
            }
          : entry,
      );
      const recovery = service.reconcile({ workspaceId, variantId, observations: killed });

      expect(recovery.classification).toBe("recovery-required");
      expect(recovery.decisions.find((decision) => decision.phase === phase)?.action).toBe(
        "preserve",
      );
      const cleanup = await service.cleanup({
        workspaceId,
        variantId,
        workspaceRoot: root,
        variantRoot,
        operationState: "recovery-required",
        checkoutOwnership: "unknown",
        processes: "unknown",
        leases: "unknown",
        artifactOwnershipVerified: false,
        integrationOwnershipVerified: false,
        verification: null,
        recovery,
        additionalEvidence: {},
      });
      expect(cleanup.classification).toBe("recovery-required");
      expect(cleanup.evidenceArchived).toBe(true);
      expect(cleanup.checkoutRemoved).toBe(false);
      expect(removed).toEqual([]);
    },
  );

  it("archives evidence before removing a terminal, verified Heniek-owned variant", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-q038-clean-"));
    roots.push(root);
    const variantRoot = join(root, "variants", "ready");
    await mkdir(variantRoot, { recursive: true });
    const events: string[] = [];
    const service = createCompositeLifecycleService({
      logsDirectory: join(root, "logs"),
      archive: memoryArchive(events),
      clock: { nowIso: () => now },
      removeCheckout: async () => {
        events.push("remove");
      },
    });
    const recovery = service.reconcile({ workspaceId, variantId, observations: observations() });
    const cleanup = await service.cleanup({
      workspaceId,
      variantId,
      workspaceRoot: root,
      variantRoot,
      operationState: "succeeded",
      checkoutOwnership: "heniek-managed",
      processes: "terminated",
      leases: "released",
      artifactOwnershipVerified: true,
      integrationOwnershipVerified: true,
      verification: verification(),
      recovery,
      additionalEvidence: { integration: "verified" },
    });

    expect(events).toEqual(["archive", "remove"]);
    expect(cleanup).toMatchObject({
      classification: "removed",
      evidenceArchived: true,
      checkoutRemoved: true,
      reasons: [],
    });
  });

  it.each(["adopted", "user-owned"] as const)(
    "never removes a terminal %s checkout",
    async (checkoutOwnership) => {
      const root = await mkdtemp(join(tmpdir(), `heniek-q038-${checkoutOwnership}-`));
      roots.push(root);
      const variantRoot = join(root, "variants", checkoutOwnership);
      await mkdir(variantRoot, { recursive: true });
      const removed: string[] = [];
      const service = createCompositeLifecycleService({
        logsDirectory: join(root, "logs"),
        archive: memoryArchive(),
        clock: { nowIso: () => now },
        removeCheckout: async (path) => {
          removed.push(path);
        },
      });
      const recovery = service.reconcile({ workspaceId, variantId, observations: observations() });
      const cleanup = await service.cleanup({
        workspaceId,
        variantId,
        workspaceRoot: root,
        variantRoot,
        operationState: "failed",
        checkoutOwnership,
        processes: "absent",
        leases: "absent",
        artifactOwnershipVerified: true,
        integrationOwnershipVerified: true,
        verification: null,
        recovery,
        additionalEvidence: {},
      });
      expect(cleanup.classification).toBe("preserved");
      expect(cleanup.checkoutRemoved).toBe(false);
      expect(removed).toEqual([]);
    },
  );

  it("does not remove anything when evidence archival fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-q038-archive-failure-"));
    roots.push(root);
    const variantRoot = join(root, "variants", "failed-archive");
    await mkdir(variantRoot, { recursive: true });
    const removed: string[] = [];
    const service = createCompositeLifecycleService({
      logsDirectory: join(root, "logs"),
      archive: {
        async archive() {
          throw new Error("archive unavailable");
        },
      },
      clock: { nowIso: () => now },
      removeCheckout: async (path) => {
        removed.push(path);
      },
    });
    const recovery = service.reconcile({ workspaceId, variantId, observations: observations() });
    await expect(
      service.cleanup({
        workspaceId,
        variantId,
        workspaceRoot: root,
        variantRoot,
        operationState: "succeeded",
        checkoutOwnership: "heniek-managed",
        processes: "absent",
        leases: "absent",
        artifactOwnershipVerified: true,
        integrationOwnershipVerified: true,
        verification: verification(),
        recovery,
        additionalEvidence: {},
      }),
    ).rejects.toThrow("archive unavailable");
    expect(removed).toEqual([]);
  });
});
