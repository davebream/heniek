import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCommandEnv,
  createCommandStageRunner,
  InvalidCommandCwdError,
  resolveCommandCwd,
  spawnCommand,
  terminateProcessGroup,
  validateStageCompletion,
} from "../src/index.js";
import type { PipelineGraphStage, StageRunnerPrepareInput } from "../src/types.js";

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function commandStage(
  overrides: Partial<PipelineGraphStage> & {
    readonly command: NonNullable<PipelineGraphStage["command"]>;
  },
): PipelineGraphStage {
  return {
    id: "build" as PipelineGraphStage["id"],
    type: "command",
    mode: "autonomous",
    optional: false,
    reads: [],
    writes: [],
    overridable: [],
    ...overrides,
  };
}

function basePrepare(
  checkoutPath: string,
  runtimeDirectory: string,
  stage: PipelineGraphStage,
): StageRunnerPrepareInput {
  return {
    attemptId: "att_1",
    runId: "run_1",
    stageId: stage.id,
    intentId: "intent_1",
    graphRevision: 1,
    generation: 1,
    attemptOrdinal: 1,
    stage,
    checkoutPath,
    runtimeDirectory,
  };
}

describe("resolveCommandCwd", () => {
  it("rejects absolute paths and traversal", async () => {
    const checkout = await tempRoot("heniek-runner-cwd-");
    expect(() => resolveCommandCwd(checkout, "/etc")).toThrow(InvalidCommandCwdError);
    expect(() => resolveCommandCwd(checkout, "../escape")).toThrow(InvalidCommandCwdError);
    expect(() => resolveCommandCwd(checkout, "ok/../../escape")).toThrow(InvalidCommandCwdError);
    expect(() => resolveCommandCwd(checkout, "has\0nul")).toThrow(InvalidCommandCwdError);
  });

  it("resolves a relative cwd under the checkout", async () => {
    const checkout = await tempRoot("heniek-runner-cwd-ok-");
    await mkdir(join(checkout, "pkg"), { recursive: true });
    expect(resolveCommandCwd(checkout, "pkg")).toBe(join(checkout, "pkg"));
  });
});

describe("buildCommandEnv", () => {
  it("copies only the allowlisted ambient keys and applies declared overrides", () => {
    const env = buildCommandEnv({
      ambient: {
        PATH: "/bin",
        HOME: "/home/test",
        LANG: "C",
        SECRET_TOKEN: "should-not-copy",
        AWS_SECRET_ACCESS_KEY: "should-not-copy",
        CUSTOM: "ambient-custom",
        TERM: "xterm",
      },
      declared: {
        CUSTOM: "declared",
        NODE_ENV: "test",
      },
      platform: "linux",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.LANG).toBe("C");
    expect(env.TERM).toBe("xterm");
    expect(env.CUSTOM).toBe("declared");
    expect(env.NODE_ENV).toBe("test");
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

describe("command argv literal passing", () => {
  it("passes spaces, quotes, and metacharacters as literal argv elements", async () => {
    const checkout = await tempRoot("heniek-runner-argv-");
    const runtime = join(checkout, ".runtime");
    const spawn = vi.fn(async (input: Parameters<typeof spawnCommand>[0]) => {
      expect(input.argv).toEqual(["/bin/echo", "hello world", 'say "hi"', "$HOME", "a;b", "x|y"]);
      expect(input.env.shell).toBeUndefined();
      return {
        pid: 4242,
        processGroupId: 4242,
        child: { pid: 4242 } as never,
        exit: Promise.resolve({ code: 0, signal: null }),
      };
    });

    const runner = createCommandStageRunner({ spawn, gracePeriodMs: 50 });
    const stage = commandStage({
      command: {
        argv: ["/bin/echo", "hello world", 'say "hi"', "$HOME", "a;b", "x|y"],
      },
    });
    await runner.prepare(basePrepare(checkout, runtime, stage));
    await runner.start("att_1");
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("really spawns without shell interpolation for $HOME", async () => {
    const checkout = await tempRoot("heniek-runner-echo-");
    const runtime = join(checkout, ".runtime");
    const handle = await spawnCommand({
      argv: ["printf", "%s", "$HOME"],
      cwd: checkout,
      env: buildCommandEnv({ declared: { HOME: "/should-not-expand" } }),
      runtimeDirectory: runtime,
    });
    const exit = await handle.exit;
    expect(exit.code).toBe(0);
    const { readFile } = await import("node:fs/promises");
    const stdout = await readFile(join(runtime, "stdout.log"), "utf8");
    expect(stdout).toBe("$HOME");
  });
});

describe("validateStageCompletion", () => {
  it("marks exitCodeAlone when only exit_code evidence exists", () => {
    const report = validateStageCompletion({
      attemptId: "att_1",
      writes: [],
      requirements: [],
      outputs: [],
      evidence: [
        {
          schemaVersion: 1,
          kind: "exit_code",
          satisfied: true,
          recordedAt: "2026-01-01T00:00:00.000Z",
          payload: { exitCode: 0 },
        },
      ],
      resultEnvelope: undefined,
      exitCode: 0,
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(report.valid).toBe(false);
    expect(report.exitCodeAlone).toBe(true);
  });

  it("fails when required evidence is missing despite exit 0", () => {
    const report = validateStageCompletion({
      attemptId: "att_1",
      writes: ["artifacts.report"],
      requirements: [{ kind: "result_envelope" }],
      outputs: [],
      evidence: [
        {
          schemaVersion: 1,
          kind: "exit_code",
          satisfied: true,
          recordedAt: "2026-01-01T00:00:00.000Z",
          payload: { exitCode: 0 },
        },
      ],
      resultEnvelope: undefined,
      exitCode: 0,
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(report.valid).toBe(false);
    expect(report.missingWrites).toContain("artifacts.report");
    expect(report.missingEvidence).toContain("result_envelope");
    expect(report.envelopeValid).toBe(false);
  });
});

describe("command finalize", () => {
  it("does not succeed on non-zero exit even if evidence is otherwise marked satisfied", async () => {
    const checkout = await tempRoot("heniek-runner-nonzero-");
    const runtime = join(checkout, ".runtime");
    let snapshot: import("../src/types.js").StageRunnerAttemptSnapshot | undefined;
    const runner = createCommandStageRunner({
      spawn: async () => ({
        pid: 7,
        processGroupId: 7,
        child: { pid: 7 } as never,
        exit: Promise.resolve({ code: 2, signal: null }),
      }),
      gracePeriodMs: 20,
      store: {
        onAttemptUpdate(attempt) {
          snapshot = attempt;
        },
      },
    });
    const stage = commandStage({
      writes: ["out.txt"],
      completion: { require: [{ kind: "non_empty_diff" }] },
      command: { argv: ["false"] },
    });
    await runner.prepare(basePrepare(checkout, runtime, stage));
    await runner.start("att_1");
    await new Promise((r) => setTimeout(r, 5));
    await runner.collect("att_1");
    if (snapshot === undefined) throw new Error("expected attempt snapshot");
    snapshot.outputs = [
      { schemaVersion: 1, reference: "out.txt", kind: "artifact", relativePath: "out.txt" },
    ];
    snapshot.evidence = [
      ...snapshot.evidence,
      {
        schemaVersion: 1,
        kind: "non_empty_diff",
        satisfied: true,
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const validation = await runner.validate("att_1");
    expect(validation.valid).toBe(true);
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("failed");
    expect(finalized.result.failure?.classification).toBe("process_failed");
  });
});

describe("process group cleanup", () => {
  it("escalates SIGTERM to SIGKILL and leaves zero processes", async () => {
    const checkout = await tempRoot("heniek-runner-pg-");
    const runtime = join(checkout, ".runtime");
    const script = join(checkout, "stubborn.sh");
    await writeFile(
      script,
      `#!/bin/sh
trap '' TERM
# Fork a child that also ignores SIGTERM
(
  trap '' TERM
  while true; do sleep 0.05; done
) &
while true; do sleep 0.05; done
`,
      { mode: 0o755 },
    );

    const handle = await spawnCommand({
      argv: ["/bin/sh", script],
      cwd: checkout,
      env: buildCommandEnv(),
      runtimeDirectory: runtime,
    });

    // Give the child time to fork.
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(-handle.processGroupId, 0)).not.toThrow();

    const report = await terminateProcessGroup({
      attemptId: "att_pg",
      processGroupId: handle.processGroupId,
      gracePeriodMs: 80,
      nowIso: () => new Date().toISOString(),
    });

    expect(report.signalSequence).toEqual(["SIGTERM", "SIGKILL"]);
    expect(report.cleaned).toBe(true);
    expect(report.descendantsRemaining).toBe(0);
    expect(() => process.kill(-handle.processGroupId, 0)).toThrow();
  }, 15_000);
});
