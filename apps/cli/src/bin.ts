#!/usr/bin/env tsx
import { fetchDaemonStatus, HeniekClientError } from "@heniek/client";
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
  return "Usage: heniek status [--json]\n       heniek --help\n       heniek --version";
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

function renderError(error: CliError, json: boolean): void {
  if (json) {
    writeJson({
      schemaVersion: 1,
      ok: false,
      command: "status",
      error,
      ...(error.observed === undefined ? {} : { observed: error.observed }),
    });
    return;
  }
  process.stderr.write(`${error.message}\n`);
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
  const validStatus =
    (argv.length === 1 && argv[0] === "status") ||
    (argv.length === 2 && argv[0] === "status" && argv[1] === "--json");
  if (!validStatus) {
    renderError({ code: "USAGE_ERROR", message: usage(), retryable: false }, json);
    return 2;
  }
  return runStatus(json);
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
