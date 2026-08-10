import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  advanceQ033Remote,
  corruptQ033Journal,
  createQ033Sandbox,
  type Q033Report,
  Q033SpikeError,
  runQ033CompositeSpike,
} from "./composite-spike.js";

interface FailureTrace {
  readonly scenario: string;
  readonly first: Q033Report | { readonly code: string; readonly phase: string };
  readonly restart?: Q033Report;
  readonly basePinPreserved?: boolean;
}

function outputDirectory(): string | undefined {
  const index = process.argv.indexOf("--output");
  const value = index < 0 ? undefined : process.argv[index + 1];
  return value === undefined ? undefined : resolve(value);
}

async function runRestartScenario(kind: "disk" | "crash"): Promise<FailureTrace> {
  const rootPath = await createQ033Sandbox();
  const first = await runQ033CompositeSpike({
    rootPath,
    scenario: `${kind}-interrupted`,
    fault: { kind, repository: "mobile" },
    cleanup: false,
  });
  const recordedApiBase = first.repositories.find(
    (repository) => repository.name === "api",
  )?.baseSha;
  const advancedApiBase = await advanceQ033Remote(rootPath, "api");
  const restart = await runQ033CompositeSpike({
    rootPath,
    scenario: `${kind}-restart`,
    cleanup: true,
  });
  const restartedApiBase = restart.repositories.find(
    (repository) => repository.name === "api",
  )?.baseSha;
  return {
    scenario: `${kind}-restart`,
    first,
    restart,
    basePinPreserved:
      recordedApiBase !== undefined &&
      restartedApiBase === recordedApiBase &&
      restartedApiBase !== advancedApiBase,
  };
}

async function runCorruptRestartScenario(): Promise<FailureTrace> {
  const rootPath = await createQ033Sandbox();
  await runQ033CompositeSpike({
    rootPath,
    scenario: "corrupt-journal-seed",
    fault: { kind: "crash", repository: "contracts" },
    cleanup: false,
  });
  await corruptQ033Journal(rootPath);
  try {
    await runQ033CompositeSpike({ rootPath, scenario: "corrupt-journal-restart", cleanup: false });
    throw new Error("Corrupt journal unexpectedly restarted.");
  } catch (error) {
    if (!(error instanceof Q033SpikeError)) throw error;
    await rm(rootPath, { recursive: true, force: true });
    return { scenario: "corrupt-journal-restart", first: { code: error.code, phase: error.phase } };
  }
}

async function main(): Promise<void> {
  const success = await runQ033CompositeSpike({ scenario: "success" });
  const failures: FailureTrace[] = [];
  for (const [kind, repository] of [
    ["clone", "worker"],
    ["setup", "api"],
    ["cancel", "contracts"],
  ] as const) {
    failures.push({
      scenario: kind,
      first: await runQ033CompositeSpike({ scenario: kind, fault: { kind, repository } }),
    });
  }
  failures.push(await runRestartScenario("disk"));
  failures.push(await runRestartScenario("crash"));
  failures.push(await runCorruptRestartScenario());

  const output = outputDirectory();
  if (output === undefined) {
    process.stdout.write(`${JSON.stringify({ success, failures }, null, 2)}\n`);
    return;
  }
  await mkdir(output, { recursive: true });
  const platformName = process.platform === "darwin" ? "macos" : process.platform;
  await writeFile(
    resolve(output, `0031-q033-composite-manifest-${platformName}.json`),
    `${JSON.stringify(success, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(output, `0031-q033-failure-traces-${platformName}.json`),
    `${JSON.stringify({ schemaVersion: "heniek.q033-failure-traces/v1", failures }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `Q033 ${process.platform}: 10 repositories, ${failures.length} failure scenarios, cleanup verified\n`,
  );
}

await main();
