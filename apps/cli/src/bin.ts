#!/usr/bin/env tsx
import { createInterface } from "node:readline/promises";
import {
  type CodebaseDetectionResult,
  detectCodebaseViaDaemon,
  fetchDaemonStatus,
  HeniekClientError,
  registerCodebaseViaDaemon,
} from "@heniek/client";
import { readApplicationHomeSource, resolveApplicationHome } from "@heniek/config";

const VERSION = "0.0.0";

type ErrorCode =
  | "USAGE_ERROR"
  | "DAEMON_UNAVAILABLE"
  | "AUTHENTICATION_FAILED"
  | "INCOMPATIBLE_PROTOCOL"
  | "REQUEST_CANCELLED"
  | "RPC_FAILURE";

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
  return "Usage: heniek status [--json]\n       heniek codebase detect [ROOT...] [--json]\n       heniek codebase register [ROOT...] [--confirm-registration] [--json]\n       heniek --help\n       heniek --version";
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
