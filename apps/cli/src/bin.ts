#!/usr/bin/env tsx
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import {
  answerRunViaDaemon,
  type CodebaseDetectionResult,
  cancelRunViaDaemon,
  detectCodebaseViaDaemon,
  fetchArtifactViaDaemon,
  fetchCapabilityCatalogueViaDaemon,
  fetchDaemonStatus,
  fetchDoctorReportViaDaemon,
  fetchRunResultViaDaemon,
  fetchRunStatusViaDaemon,
  HeniekClientError,
  registerCodebaseViaDaemon,
  resumeRunViaDaemon,
  startStageViaDaemon,
} from "@heniek/client";
import { readApplicationHomeSource, resolveApplicationHome } from "@heniek/config";
import {
  ClaudexorRuntimeError,
  type ClaudexorRuntimeErrorCode,
  createBlockedCompatibilityGate,
  createClaudexorRuntimeManager,
  createClaudexorRuntimeProbe,
  createCommandCompatibilityGate,
  type RuntimeIdentity,
  type RuntimeMutationResult,
} from "@heniek/runtime-claudexor";

const VERSION = "0.0.0";

type ErrorCode =
  | "USAGE_ERROR"
  | "DAEMON_UNAVAILABLE"
  | "AUTHENTICATION_FAILED"
  | "INCOMPATIBLE_PROTOCOL"
  | "REQUEST_CANCELLED"
  | "RPC_FAILURE"
  | ClaudexorRuntimeErrorCode;

interface CliError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly observed?: {
    readonly health: string;
    readonly daemonVersion?: number;
    readonly schemaCompatibility?: string;
  };
}

function usage(): string {
  return "Usage: heniek status [--json]\n       heniek codebase detect [ROOT...] [--json]\n       heniek codebase register [ROOT...] [--confirm-registration] [--json]\n       heniek stage start --task-file PATH --artifact-path PATH [--json]\n       heniek run status RUN_ID [--json]\n       heniek run answer RUN_ID INTERACTION_ID --answers-json JSON [--json]\n       heniek run resume RUN_ID [--input-artifact ARTIFACT_ID...] [--json]\n       heniek run cancel RUN_ID [--json]\n       heniek run result RUN_ID [--json]\n       heniek artifact get ARTIFACT_ID [--output PATH] [--json]\n       heniek engine list [--refresh] [--json]\n       heniek runtime list [--json]\n       heniek runtime install claudexor VERSION [--json]\n       heniek runtime activate claudexor VERSION [--json]\n       heniek runtime upgrade claudexor VERSION [--json]\n       heniek runtime rollback claudexor [--json]\n       heniek runtime adopt claudexor --entry ABSOLUTE_PATH [--json]\n       heniek doctor [--json]\n       heniek --help\n       heniek --version";
}

function exitCode(code: ErrorCode): number {
  switch (code) {
    case "USAGE_ERROR":
      return 2;
    case "DAEMON_UNAVAILABLE":
      return 3;
    case "AUTHENTICATION_FAILED":
      return 4;
    case "INCOMPATIBLE_PROTOCOL":
      return 5;
    case "REQUEST_CANCELLED":
      return 6;
    case "RPC_FAILURE":
      return 7;
    default:
      return 8;
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function renderError(error: CliError, json: boolean, command = "status"): void {
  if (json) {
    writeJson({
      schemaVersion: 1,
      ok: false,
      command,
      error,
      ...(error.observed === undefined ? {} : { observed: error.observed }),
    });
    return;
  }
  process.stderr.write(`${error.message}\n`);
}

function applicationHome() {
  return resolveApplicationHome(
    readApplicationHomeSource(process.env, process.platform, process.env.HOME ?? ""),
  );
}

function runtimeManager() {
  const promotionCommand = process.env.HENIEK_CLAUDEXOR_PROMOTION_COMMAND;
  const gate =
    promotionCommand === undefined || promotionCommand.length === 0
      ? createBlockedCompatibilityGate()
      : createCommandCompatibilityGate({ command: promotionCommand });
  return createClaudexorRuntimeManager({
    home: applicationHome(),
    gate,
    probe: createClaudexorRuntimeProbe(),
  });
}

function renderRuntimeIdentity(label: string, identity: RuntimeIdentity | null): void {
  if (identity === null) {
    process.stdout.write(`${label}: none\n`);
    return;
  }
  process.stdout.write(
    `${label}: ${identity.version} ${identity.buildSha} (${identity.sourceMode})\n` +
      `  entry: ${identity.entryPath}\n` +
      `  binary sha256: ${identity.binarySha256}\n` +
      (identity.archiveSha256 === undefined ? "" : `  archive sha256: ${identity.archiveSha256}\n`),
  );
}

async function runRuntime(argv: readonly string[], jsonOutput: boolean): Promise<number> {
  const commandArgs = argv.filter((argument) => argument !== "--json");
  const operation = commandArgs[1] ?? "unknown";
  const command = `runtime.${operation}`;
  try {
    const manager = runtimeManager();
    if (operation === "list" && commandArgs.length === 2) {
      const inventory = await manager.inventory();
      if (jsonOutput) writeJson({ schemaVersion: 1, ok: true, command, result: inventory });
      else {
        renderRuntimeIdentity("active", inventory.active);
        renderRuntimeIdentity("previous", inventory.previous);
        if (inventory.installed.length === 0) process.stdout.write("installed: none\n");
        else {
          process.stdout.write("installed:\n");
          for (const identity of inventory.installed) renderRuntimeIdentity("-", identity);
        }
      }
      return 0;
    }

    let result: RuntimeMutationResult;
    if (
      (operation === "install" || operation === "activate" || operation === "upgrade") &&
      commandArgs.length === 4 &&
      commandArgs[2] === "claudexor"
    ) {
      const version = commandArgs[3] as string;
      result =
        operation === "install"
          ? await manager.install(version)
          : operation === "activate"
            ? await manager.activate(version)
            : await manager.upgrade(version);
    } else if (
      operation === "rollback" &&
      commandArgs.length === 3 &&
      commandArgs[2] === "claudexor"
    ) {
      result = await manager.rollback();
    } else if (
      operation === "adopt" &&
      commandArgs.length === 5 &&
      commandArgs[2] === "claudexor" &&
      commandArgs[3] === "--entry"
    ) {
      result = await manager.adopt(commandArgs[4] as string);
    } else {
      return 2;
    }

    if (jsonOutput) writeJson({ schemaVersion: 1, ok: true, command, result });
    else {
      process.stdout.write(`Claudexor runtime ${result.action} succeeded.\n`);
      renderRuntimeIdentity("active", result.activeAfter);
    }
    return 0;
  } catch (error) {
    const failure: CliError =
      error instanceof ClaudexorRuntimeError
        ? {
            code: error.code,
            message: error.message,
            retryable: error.code === "RUNTIME_BUSY",
          }
        : {
            code: "RUNTIME_INTEGRITY_FAILED",
            message: "The local Claudexor runtime operation failed.",
            retryable: false,
          };
    renderError(failure, jsonOutput, command);
    return exitCode(failure.code);
  }
}

function renderDetection(detection: CodebaseDetectionResult): void {
  const blocked =
    detection.instructionSnapshot.readiness === "blocked" ||
    detection.diagnostics.some((diagnostic) => diagnostic.severity === "blocker");
  process.stdout.write(
    `Codebase:   ${detection.name}\nRoot:       ${detection.rootPath}\nTopology:   ${detection.topologySha256}\nRegistered: ${detection.registrationState}\nReadiness:  ${blocked ? "blocked" : "ready"}\nRepositories:\n`,
  );
  for (const repository of detection.repositories) {
    const selected =
      repository.defaultRemote === null
        ? "no default remote"
        : `${repository.defaultRemote}/${repository.defaultBranch ?? "unknown"}`;
    process.stdout.write(`  - ${repository.path} (${selected})\n`);
  }
  const diagnostics = [
    ...detection.diagnostics.map((diagnostic) => ({
      classification: diagnostic.severity,
      message: diagnostic.message,
    })),
    ...detection.instructionSnapshot.diagnostics
      .filter((diagnostic) => diagnostic.classification !== "additive")
      .map((diagnostic) => ({
        classification: diagnostic.classification,
        message: diagnostic.message,
      })),
  ];
  if (diagnostics.length > 0) {
    process.stdout.write("Diagnostics:\n");
    for (const diagnostic of diagnostics) {
      process.stdout.write(`  - [${diagnostic.classification}] ${diagnostic.message}\n`);
    }
  }
}

function clientFailure(error: unknown, fallback: string): HeniekClientError {
  return error instanceof HeniekClientError
    ? error
    : new HeniekClientError("RPC_FAILURE", fallback, false);
}

async function runCodebaseDetect(roots: readonly string[], json: boolean): Promise<number> {
  try {
    const detection = await detectCodebaseViaDaemon(applicationHome(), roots);
    if (json) {
      writeJson({ schemaVersion: 1, ok: true, command: "codebase.detect", result: detection });
    } else {
      renderDetection(detection);
    }
    return 0;
  } catch (error) {
    const failure = clientFailure(error, "Heniek Codebase detection failed.");
    renderError(
      { code: failure.code, message: failure.message, retryable: failure.retryable },
      json,
      "codebase.detect",
    );
    return exitCode(failure.code);
  }
}

async function confirmRegistration(): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question("Register this Codebase? [y/N] ");
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

async function runCodebaseRegister(
  roots: readonly string[],
  json: boolean,
  confirmedByFlag: boolean,
): Promise<number> {
  if (!confirmedByFlag && (json || !process.stdin.isTTY || !process.stdout.isTTY)) {
    renderError(
      {
        code: "USAGE_ERROR",
        message: "Non-interactive Codebase registration requires --confirm-registration.",
        retryable: false,
      },
      json,
      "codebase.register",
    );
    return 2;
  }
  try {
    const home = applicationHome();
    const detection = await detectCodebaseViaDaemon(home, roots);
    if (!json) renderDetection(detection);
    const confirmed = confirmedByFlag || (await confirmRegistration());
    if (!confirmed) {
      renderError(
        {
          code: "USAGE_ERROR",
          message: "Codebase registration was not confirmed.",
          retryable: false,
        },
        json,
        "codebase.register",
      );
      return 2;
    }
    const registration = await registerCodebaseViaDaemon(home, {
      roots,
      expectedTopologySha256: detection.topologySha256,
    });
    if (json) {
      writeJson({
        schemaVersion: 1,
        ok: true,
        command: "codebase.register",
        result: registration,
      });
    } else {
      process.stdout.write(
        `Registered ${registration.codebaseId} (${registration.readiness}) at ${registration.rootPath}\n`,
      );
    }
    return 0;
  } catch (error) {
    const failure = clientFailure(error, "Heniek Codebase registration failed.");
    renderError(
      { code: failure.code, message: failure.message, retryable: failure.retryable },
      json,
      "codebase.register",
    );
    return exitCode(failure.code);
  }
}

async function runStatus(json: boolean): Promise<number> {
  try {
    const home = resolveApplicationHome(
      readApplicationHomeSource(process.env, process.platform, process.env.HOME ?? ""),
    );
    const snapshot = await fetchDaemonStatus(home);
    const result = {
      schemaVersion: 1,
      health: "healthy" as const,
      daemon: snapshot.status,
      protocol: {
        clientVersion: 1,
        daemonVersion: snapshot.daemonVersion,
        negotiatedVersion: 1,
        compatibility: "compatible" as const,
      },
      schemas: {
        clientManifestVersion: "heniek.contracts-manifest.v1",
        daemonManifestVersion: snapshot.daemonManifestVersion,
        compatibility: snapshot.schemaCompatibility,
      },
    };
    if (json) {
      writeJson({ schemaVersion: 1, ok: true, command: "status", result });
    } else {
      const { reconciliation, artifactRecovery } = snapshot.status;
      process.stdout.write(
        `Daemon:    ${snapshot.status.lifecycleState}\nStarted:   ${snapshot.status.startedAt}\nProtocol:  v1 (compatible)\nSchemas:   ${snapshot.schemaCompatibility}\nRecovery:  ${reconciliation.probed} probed · ${reconciliation.resumable} resumable · ${reconciliation.failed} failed · ${reconciliation.cancelled} cancelled · ${reconciliation.unknown} unknown\nArtifacts: ${artifactRecovery.removedIncoming} incoming removed · ${artifactRecovery.skippedIncoming} skipped · ${artifactRecovery.unreferencedBlobs} unreferenced\n`,
      );
    }
    return 0;
  } catch (error) {
    const clientError =
      error instanceof HeniekClientError
        ? error
        : new HeniekClientError("RPC_FAILURE", "Heniek status failed.", false);
    const observed =
      clientError.observed === undefined
        ? undefined
        : {
            health: clientError.code === "INCOMPATIBLE_PROTOCOL" ? "incompatible" : "failed",
            ...clientError.observed,
          };
    renderError(
      {
        code: clientError.code,
        message: clientError.message,
        retryable: clientError.retryable,
        ...(observed === undefined ? {} : { observed }),
      },
      json,
    );
    return exitCode(clientError.code);
  }
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function optionValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith("--")) values.push(value);
    }
  }
  return values;
}

async function domainCommand<T>(
  command: string,
  json: boolean,
  operation: () => Promise<T>,
  render?: (result: T) => void,
): Promise<number> {
  try {
    const result = await operation();
    if (json) writeJson({ schemaVersion: 1, ok: true, command, result });
    else if (render !== undefined) render(result);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const failure = clientFailure(error, `Heniek ${command} failed.`);
    renderError(
      { code: failure.code, message: failure.message, retryable: failure.retryable },
      json,
      command,
    );
    return exitCode(failure.code);
  }
}

async function runStageStart(argv: readonly string[], json: boolean): Promise<number> {
  const taskFile = optionValue(argv, "--task-file");
  const artifactPath = optionValue(argv, "--artifact-path");
  if (taskFile === undefined || artifactPath === undefined) return 2;
  let prompt: string;
  try {
    prompt = await readFile(taskFile, "utf8");
  } catch {
    renderError(
      { code: "USAGE_ERROR", message: "The task file could not be read.", retryable: false },
      json,
      "stage.start",
    );
    return 2;
  }
  return domainCommand(
    "stage.start",
    json,
    () =>
      startStageViaDaemon(applicationHome(), {
        currentDirectory: process.cwd(),
        prompt,
        artifactPath,
      }),
    (result: { runId: string; stageId: string; status: string }) => {
      process.stdout.write(
        `Run:    ${result.runId}\nStage:  ${result.stageId}\nStatus: ${result.status}\n`,
      );
    },
  );
}

async function runDomain(argv: readonly string[], json: boolean): Promise<number> {
  const operation = argv[1];
  const runId = argv[2];
  if (runId === undefined) return 2;
  if (operation === "status") {
    return domainCommand("run.status", json, () =>
      fetchRunStatusViaDaemon(applicationHome(), runId),
    );
  }
  if (operation === "answer") {
    const interactionId = argv[3];
    const encoded = optionValue(argv, "--answers-json");
    if (interactionId === undefined || encoded === undefined) return 2;
    let answers: unknown;
    try {
      answers = JSON.parse(encoded);
    } catch {
      return 2;
    }
    if (!Array.isArray(answers)) return 2;
    return domainCommand("run.answer", json, () =>
      answerRunViaDaemon(applicationHome(), runId, {
        schemaVersion: 1,
        interactionId: interactionId as never,
        answers: answers as never,
      }),
    );
  }
  if (operation === "resume") {
    return domainCommand("run.resume", json, () =>
      resumeRunViaDaemon(applicationHome(), runId, optionValues(argv, "--input-artifact") as never),
    );
  }
  if (operation === "cancel") {
    return domainCommand("run.cancel", json, () => cancelRunViaDaemon(applicationHome(), runId));
  }
  if (operation === "result") {
    return domainCommand("run.result", json, () =>
      fetchRunResultViaDaemon(applicationHome(), runId),
    );
  }
  return 2;
}

async function runArtifactGet(argv: readonly string[], json: boolean): Promise<number> {
  const artifactId = argv[2];
  if (artifactId === undefined) return 2;
  try {
    const result = await fetchArtifactViaDaemon(applicationHome(), artifactId);
    const bytes = Buffer.from(result.contentBase64, "base64");
    if (bytes.byteLength !== result.byteLength) {
      throw new HeniekClientError("RPC_FAILURE", "Artifact response length is invalid.", false);
    }
    const output = optionValue(argv, "--output");
    if (output !== undefined) await writeFile(output, bytes);
    if (json) {
      writeJson({ schemaVersion: 1, ok: true, command: "artifact.get", result });
    } else if (output === undefined) {
      process.stdout.write(bytes);
    } else {
      process.stdout.write(`Wrote ${result.byteLength} bytes to ${output}\n`);
    }
    return 0;
  } catch (error) {
    const failure = clientFailure(error, "Heniek artifact retrieval failed.");
    renderError(
      { code: failure.code, message: failure.message, retryable: failure.retryable },
      json,
      "artifact.get",
    );
    return exitCode(failure.code);
  }
}

async function runDoctor(json: boolean): Promise<number> {
  try {
    const report = await fetchDoctorReportViaDaemon(applicationHome());
    if (json)
      writeJson({
        schemaVersion: 1,
        ok: report.health !== "failed",
        command: "doctor",
        result: report,
      });
    else {
      process.stdout.write(`Heniek doctor: ${report.health}\n`);
      for (const check of report.checks) {
        process.stdout.write(`  [${check.status}] ${check.category}: ${check.message}\n`);
      }
    }
    return report.health === "failed" ? 1 : 0;
  } catch (error) {
    const failure = clientFailure(error, "Heniek doctor failed.");
    renderError(
      { code: failure.code, message: failure.message, retryable: failure.retryable },
      json,
      "doctor",
    );
    return exitCode(failure.code);
  }
}

async function runEngineList(refresh: boolean, json: boolean): Promise<number> {
  try {
    const catalogue = await fetchCapabilityCatalogueViaDaemon(applicationHome(), { refresh });
    if (json) {
      writeJson({ schemaVersion: 1, ok: true, command: "engine.list", result: catalogue });
    } else {
      const header = [
        "ENGINE",
        "ACCOUNT",
        "INSTALL",
        "AUTH",
        "COMPAT",
        "CAPACITY",
        "READY",
        "MODELS",
        "FRESH",
      ];
      const rows = catalogue.entries.map((entry) => [
        entry.engine,
        entry.accountId ?? "native/-",
        entry.installation,
        entry.authentication,
        entry.compatibility,
        entry.capacity,
        entry.ready ? "yes" : "no",
        entry.models.map((model) => model.id).join(",") || "-",
        entry.freshness,
      ]);
      const widths = header.map((value, index) =>
        Math.max(value.length, ...rows.map((row) => row[index]?.length ?? 0)),
      );
      const render = (row: readonly string[]) =>
        row
          .map((value, index) => value.padEnd(widths[index] ?? value.length))
          .join("  ")
          .trimEnd();
      process.stdout.write(`${render(header)}\n${rows.map(render).join("\n")}\n`);
    }
    return 0;
  } catch (error) {
    const failure = clientFailure(error, "Capability discovery failed.");
    renderError(
      { code: failure.code, message: failure.message, retryable: failure.retryable },
      json,
      "engine.list",
    );
    return exitCode(failure.code);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json");
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (argv[0] === "status") {
    const validStatus = argv.length === 1 || (argv.length === 2 && argv[1] === "--json");
    if (validStatus) return runStatus(json);
  }

  if (argv[0] === "stage" && argv[1] === "start") {
    const code = await runStageStart(argv, json);
    if (code !== 2) return code;
  }

  if (argv[0] === "run") {
    const code = await runDomain(argv, json);
    if (code !== 2) return code;
  }

  if (argv[0] === "artifact" && argv[1] === "get") {
    const code = await runArtifactGet(argv, json);
    if (code !== 2) return code;
  }

  if (argv[0] === "runtime") {
    const code = await runRuntime(argv, json);
    if (code !== 2) return code;
  }

  if (argv[0] === "engine" && argv[1] === "list") {
    const options = argv.slice(2);
    if (
      options.every((option) => option === "--refresh" || option === "--json") &&
      new Set(options).size === options.length
    ) {
      return runEngineList(argv.includes("--refresh"), json);
    }
  }

  if (argv[0] === "doctor" && (argv.length === 1 || (argv.length === 2 && json))) {
    return runDoctor(json);
  }

  if (argv[0] === "codebase" && (argv[1] === "detect" || argv[1] === "register")) {
    const operation = argv[1];
    const allowedFlags =
      operation === "detect" ? new Set(["--json"]) : new Set(["--json", "--confirm-registration"]);
    const options = argv.slice(2).filter((argument) => argument.startsWith("--"));
    if (
      options.every((option) => allowedFlags.has(option)) &&
      new Set(options).size === options.length
    ) {
      const roots = argv.slice(2).filter((argument) => !argument.startsWith("--"));
      const effectiveRoots = roots.length === 0 ? [process.cwd()] : roots;
      if (operation === "detect") return runCodebaseDetect(effectiveRoots, json);
      return runCodebaseRegister(effectiveRoots, json, argv.includes("--confirm-registration"));
    }
  }

  renderError({ code: "USAGE_ERROR", message: usage(), retryable: false }, json);
  return 2;
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
