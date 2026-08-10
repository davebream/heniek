import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  advanceQ033Remote,
  corruptQ033Journal,
  createQ033Sandbox,
  Q033_REPOSITORIES,
  type Q033SpikeError,
  runQ033CompositeSpike,
} from "../scripts/q033/composite-spike.js";

describe("Q033 ten-repository composite workspace spike", () => {
  it("provisions, inspects, modifies, verifies, and cleans ten scoped worktrees", async () => {
    const report = await runQ033CompositeSpike();

    expect(report.repositoryCount).toBe(10);
    expect(report.compositeRootIsGitRepository).toBe(false);
    expect(report.semanticReadSet).toHaveLength(10);
    expect(report.writeSet).toEqual(["api", "web", "e2e"]);
    expect(report.crossRepositoryVerification).toBe(true);
    expect(
      report.repositories
        .filter((repository) => repository.changed)
        .map((repository) => repository.name),
    ).toEqual(["api", "web", "e2e"]);
    expect(
      report.repositories.every((repository) => repository.checkoutHeadSha === repository.baseSha),
    ).toBe(true);
    expect(report.repositories.every((repository) => repository.phase === "setup-completed")).toBe(
      true,
    );
    for (const repository of report.repositories) {
      const configured = Q033_REPOSITORIES.find((candidate) => candidate.name === repository.name);
      for (const dependency of configured?.dependencies ?? []) {
        expect(report.setupOrder.indexOf(dependency)).toBeLessThan(
          report.setupOrder.indexOf(repository.name),
        );
      }
    }
    expect(report.metrics.peakChildProcesses).toBeLessThanOrEqual(3);
    expect(report.metrics.peakChildProcesses).toBeGreaterThan(1);
    expect(report.metrics.remainingChildProcesses).toBe(0);
    expect(report.metrics.logicalBytesAtPeak).toBeGreaterThan(0);
    expect(report.metrics.logicalBytesAfterCleanup).toBe(0);
    expect(report.cleanup).toEqual({ requested: true, completed: true, idempotent: true });
  }, 60_000);

  it.each([
    ["clone", "worker", "CLONE_FAILED"],
    ["setup", "api", "SETUP_FAILED"],
    ["cancel", "contracts", "CANCELLED"],
  ] as const)(
    "records and cleans an injected %s failure",
    async (kind, repository, code) => {
      const report = await runQ033CompositeSpike({ fault: { kind, repository } });
      expect(report.failures).toContainEqual({
        code,
        phase: kind === "clone" ? "clone" : "setup",
        repository,
        recovered: false,
      });
      expect(report.metrics.remainingChildProcesses).toBe(0);
      expect(report.cleanup.completed).toBe(true);
      expect(JSON.stringify(report)).not.toContain("fixture-secret");
      if (kind === "setup") {
        expect(report.repositories.find((candidate) => candidate.name === "docs")?.phase).toBe(
          "setup-completed",
        );
        expect(report.repositories.find((candidate) => candidate.name === "web")?.phase).toBe(
          "blocked",
        );
      }
      if (kind === "clone") {
        expect(
          report.repositories.find((candidate) => candidate.name === "api")?.checkoutHeadSha,
        ).not.toBeNull();
        expect(report.repositories.find((candidate) => candidate.name === "web")?.phase).toBe(
          "pending",
        );
      }
      if (kind === "cancel") {
        expect(report.repositories.some((candidate) => candidate.phase === "cancelled")).toBe(true);
      }
    },
    60_000,
  );

  it.each(["disk", "crash"] as const)(
    "reconciles an uncertain %s boundary without moving base pins",
    async (kind) => {
      const rootPath = await createQ033Sandbox();
      const first = await runQ033CompositeSpike({
        rootPath,
        fault: { kind, repository: "mobile" },
        cleanup: false,
      });
      const pinned = first.repositories.find((repository) => repository.name === "api")?.baseSha;
      const moved = await advanceQ033Remote(rootPath, "api");
      expect(moved).not.toBe(pinned);
      expect(first.failures[0]?.code).toBe(kind === "disk" ? "ENOSPC" : "PROCESS_INTERRUPTED");

      const restarted = await runQ033CompositeSpike({ rootPath });
      expect(restarted.failures).toEqual([]);
      expect(restarted.repositories.find((repository) => repository.name === "api")?.baseSha).toBe(
        pinned,
      );
      expect(
        restarted.repositories.every((repository) => repository.phase === "setup-completed"),
      ).toBe(true);
      expect(restarted.repositories.every((repository) => repository.setupAttempts === 1)).toBe(
        true,
      );
      expect(restarted.cleanup.completed).toBe(true);
    },
    60_000,
  );

  it("rejects corrupt and incompatible restart journals with typed blockers", async () => {
    const corruptRoot = await createQ033Sandbox();
    await runQ033CompositeSpike({
      rootPath: corruptRoot,
      fault: { kind: "crash", repository: "contracts" },
      cleanup: false,
    });
    await corruptQ033Journal(corruptRoot);
    await expect(
      runQ033CompositeSpike({ rootPath: corruptRoot, cleanup: false }),
    ).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT",
      phase: "restart",
    } satisfies Partial<Q033SpikeError>);
    await rm(corruptRoot, { recursive: true, force: true });

    const mismatchRoot = await createQ033Sandbox();
    await runQ033CompositeSpike({
      rootPath: mismatchRoot,
      fault: { kind: "crash", repository: "contracts" },
      cleanup: false,
    });
    const journalPath = join(mismatchRoot, "workspaces", "ws_q033", "q033-journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { intentSha256: string };
    journal.intentSha256 = "0".repeat(64);
    await writeFile(journalPath, JSON.stringify(journal), "utf8");
    await expect(
      runQ033CompositeSpike({ rootPath: mismatchRoot, cleanup: false }),
    ).rejects.toMatchObject({
      code: "RESTART_INTENT_MISMATCH",
      phase: "restart",
    } satisfies Partial<Q033SpikeError>);
    await rm(mismatchRoot, { recursive: true, force: true });
  }, 60_000);
});
