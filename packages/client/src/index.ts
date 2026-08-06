import { createConnection, type Socket } from "node:net";
import type { ApplicationHome } from "@heniek/config";
import type { CodebaseDetectionResult, RegisteredCodebase } from "@heniek/contracts";
import {
  buildSignedRequest,
  CODEBASE_DETECT_METHOD,
  CODEBASE_DETECT_V1_METHOD,
  CODEBASE_DETECTION_SCHEMA_ID,
  CODEBASE_DETECTION_SCHEMA_SHA256,
  CODEBASE_REGISTER_METHOD,
  CODEBASE_REGISTER_V1_METHOD,
  credentialFromPersisted,
  DAEMON_HELLO_METHOD,
  DAEMON_NEGOTIATE_METHOD,
  DAEMON_STATUS_SCHEMA_ID,
  DAEMON_STATUS_SCHEMA_SHA256,
  DAEMON_STATUS_V1_METHOD,
  type DaemonCredential,
  JSON_RPC_VERSION,
  MAX_LINE_BYTES,
  REGISTERED_CODEBASE_SCHEMA_ID,
  REGISTERED_CODEBASE_SCHEMA_SHA256,
  RPC_CANCEL_METHOD,
  TRANSPORT_VERSION,
  zeroCredential,
} from "@heniek/protocol";
import { createFileSecretStore } from "@heniek/secrets";

export type ClientFailureCode =
  | "DAEMON_UNAVAILABLE"
  | "AUTHENTICATION_FAILED"
  | "INCOMPATIBLE_PROTOCOL"
  | "REQUEST_CANCELLED"
  | "RPC_FAILURE";

export class HeniekClientError extends Error {
  constructor(
    readonly code: ClientFailureCode,
    message: string,
    readonly retryable: boolean,
    readonly observed?: { readonly daemonVersion?: number; readonly schemaCompatibility?: string },
  ) {
    super(message);
    this.name = "HeniekClientError";
  }
}

export interface DaemonStatus {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly lifecycleState: string;
  readonly startedAt: string;
  readonly reconciliation: Readonly<
    Record<"probed" | "resumable" | "failed" | "cancelled" | "unknown", number>
  >;
  readonly artifactRecovery: Readonly<
    Record<"removedIncoming" | "skippedIncoming" | "unreferencedBlobs", number>
  >;
}

export interface StatusSnapshot {
  readonly status: DaemonStatus;
  readonly daemonVersion: number;
  readonly daemonManifestVersion: string;
  readonly schemaCompatibility: "exact" | "incompatible";
}

export type { CodebaseDetectionResult, RegisteredCodebase } from "@heniek/contracts";

interface RpcRequirement {
  readonly name: "daemon.status" | "codebase.detect" | "codebase.register";
  readonly wireMethod: "daemon.status.v1" | "codebase.detect.v1" | "codebase.register.v1";
  readonly schemaId: string;
  readonly sha256: string;
}

interface HelloResult {
  readonly protocolVersion: number;
  readonly challenge: string;
  readonly keyId: string;
}

interface Response {
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseResult(response: Response): unknown {
  if (response.error !== undefined) {
    const code = response.error.code;
    if (code === -32001) {
      throw new HeniekClientError(
        "AUTHENTICATION_FAILED",
        "Heniek daemon authentication failed.",
        false,
      );
    }
    if (code === -32002) {
      throw new HeniekClientError("REQUEST_CANCELLED", "Heniek status was cancelled.", false);
    }
    if (code === -32003) {
      throw new HeniekClientError(
        "INCOMPATIBLE_PROTOCOL",
        "Heniek daemon protocol is incompatible.",
        false,
      );
    }
    throw new HeniekClientError("RPC_FAILURE", "The Heniek daemon rejected the request.", false);
  }
  if (response.result === undefined) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned a malformed response.",
      false,
    );
  }
  return response.result;
}

function parseHello(value: unknown): HelloResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "challenge",
      "instanceId",
      "keyId",
      "macAlgorithm",
      "protocolVersion",
      "schemaVersion",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.protocolVersion !== "number" ||
    typeof value.instanceId !== "string" ||
    value.macAlgorithm !== "hmac-sha256"
  ) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid hello response.",
      false,
    );
  }
  if (typeof value.challenge !== "string" || !/^[a-f0-9]{64}$/.test(value.challenge)) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid hello response.",
      false,
    );
  }
  if (typeof value.keyId !== "string" || value.keyId.length === 0) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid hello response.",
      false,
    );
  }
  return { protocolVersion: value.protocolVersion, challenge: value.challenge, keyId: value.keyId };
}

function parseNegotiation(
  value: unknown,
  requirement: RpcRequirement,
): { readonly manifestVersion: string } {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "compatibility",
      "contractManifestVersion",
      "methods",
      "reasons",
      "schemaVersion",
      "selectedTransportVersion",
    ]) ||
    value.schemaVersion !== 1 ||
    value.compatibility !== "compatible" ||
    value.selectedTransportVersion !== TRANSPORT_VERSION ||
    typeof value.contractManifestVersion !== "string" ||
    !Array.isArray(value.methods) ||
    !Array.isArray(value.reasons)
  ) {
    throw new HeniekClientError(
      "INCOMPATIBLE_PROTOCOL",
      "Heniek daemon protocol is incompatible.",
      false,
      { schemaCompatibility: "incompatible" },
    );
  }
  const negotiated = value.methods.find(
    (method) =>
      isRecord(method) &&
      hasExactKeys(method, [
        "methodVersion",
        "name",
        "resultSchemaId",
        "resultSchemaSha256",
        "wireMethod",
      ]) &&
      method.name === requirement.name &&
      method.methodVersion === 1 &&
      method.wireMethod === requirement.wireMethod &&
      method.resultSchemaId === requirement.schemaId &&
      method.resultSchemaSha256 === requirement.sha256,
  );
  if (negotiated === undefined) {
    throw new HeniekClientError(
      "INCOMPATIBLE_PROTOCOL",
      "Heniek daemon protocol is incompatible.",
      false,
      { schemaCompatibility: "incompatible" },
    );
  }
  return { manifestVersion: value.contractManifestVersion };
}

function parseStatus(value: unknown): DaemonStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "artifactRecovery",
      "instanceId",
      "lifecycleState",
      "reconciliation",
      "schemaVersion",
      "startedAt",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.instanceId !== "string"
  ) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid status response.",
      false,
    );
  }
  if (typeof value.lifecycleState !== "string" || typeof value.startedAt !== "string") {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid status response.",
      false,
    );
  }
  const reconciliation = value.reconciliation;
  const artifactRecovery = value.artifactRecovery;
  const reconciliationKeys = ["probed", "resumable", "failed", "cancelled", "unknown"] as const;
  const artifactKeys = ["removedIncoming", "skippedIncoming", "unreferencedBlobs"] as const;
  if (
    !isRecord(reconciliation) ||
    !isRecord(artifactRecovery) ||
    !hasExactKeys(reconciliation, [...reconciliationKeys]) ||
    !hasExactKeys(artifactRecovery, [...artifactKeys]) ||
    !reconciliationKeys.every((key) => typeof reconciliation[key] === "number") ||
    !artifactKeys.every((key) => typeof artifactRecovery[key] === "number")
  ) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid status response.",
      false,
    );
  }
  return value as unknown as DaemonStatus;
}

const STATUS_REQUIREMENT: RpcRequirement = {
  name: "daemon.status",
  wireMethod: DAEMON_STATUS_V1_METHOD,
  schemaId: DAEMON_STATUS_SCHEMA_ID,
  sha256: DAEMON_STATUS_SCHEMA_SHA256,
};

const DETECT_REQUIREMENT: RpcRequirement = {
  name: CODEBASE_DETECT_METHOD,
  wireMethod: CODEBASE_DETECT_V1_METHOD,
  schemaId: CODEBASE_DETECTION_SCHEMA_ID,
  sha256: CODEBASE_DETECTION_SCHEMA_SHA256,
};

const REGISTER_REQUIREMENT: RpcRequirement = {
  name: CODEBASE_REGISTER_METHOD,
  wireMethod: CODEBASE_REGISTER_V1_METHOD,
  schemaId: REGISTERED_CODEBASE_SCHEMA_ID,
  sha256: REGISTERED_CODEBASE_SCHEMA_SHA256,
};

function parseDetection(value: unknown): CodebaseDetectionResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "codebaseId",
      "diagnostics",
      "instructionSnapshot",
      "name",
      "registrationState",
      "repositories",
      "rootPath",
      "schemaVersion",
      "sourceRepositoryPath",
      "topologySha256",
    ]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.repositories) ||
    !Array.isArray(value.diagnostics) ||
    !isRecord(value.instructionSnapshot) ||
    typeof value.name !== "string" ||
    typeof value.rootPath !== "string" ||
    typeof value.topologySha256 !== "string"
  ) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid Codebase detection response.",
      false,
    );
  }
  return value as unknown as CodebaseDetectionResult;
}

function parseRegistration(value: unknown): RegisteredCodebase {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "codebaseId",
      "configurationSha256",
      "diagnostics",
      "instructionSnapshot",
      "name",
      "readiness",
      "registeredAt",
      "repositories",
      "rootPath",
      "schemaVersion",
      "sourceRepositoryPath",
      "topologySha256",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.codebaseId !== "string" ||
    !Array.isArray(value.repositories) ||
    !Array.isArray(value.diagnostics) ||
    !isRecord(value.instructionSnapshot) ||
    typeof value.configurationSha256 !== "string"
  ) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid Codebase registration response.",
      false,
    );
  }
  return value as unknown as RegisteredCodebase;
}

class LineClient {
  #buffer = "";
  #closed = false;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (response: Response) => void; reject: (error: Error) => void }
  >();

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.rejectAll());
    socket.on("close", () => {
      this.#closed = true;
      this.rejectAll();
    });
  }

  static connect(path: string): Promise<LineClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path });
      const onError = () =>
        reject(
          new HeniekClientError("DAEMON_UNAVAILABLE", "Heniek daemon is not reachable.", true),
        );
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve(new LineClient(socket));
      });
    });
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    credential?: DaemonCredential,
    challenge?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.#nextId++;
    if (this.#closed) {
      throw new HeniekClientError("DAEMON_UNAVAILABLE", "Heniek daemon is not reachable.", true);
    }
    if (signal?.aborted) {
      throw new HeniekClientError("REQUEST_CANCELLED", "Heniek status was cancelled.", false);
    }
    const line =
      credential === undefined || challenge === undefined
        ? JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method })
        : buildSignedRequest(credential, challenge, id, method, id - 1, params);
    return new Promise<unknown>((resolve, reject) => {
      const cancel = () => {
        this.#pending.delete(id);
        if (credential !== undefined && challenge !== undefined) {
          void this.request(
            RPC_CANCEL_METHOD,
            { schemaVersion: 1, requestId: id },
            credential,
            challenge,
          ).catch(() => undefined);
        }
        reject(new HeniekClientError("REQUEST_CANCELLED", "Heniek status was cancelled.", false));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.#pending.set(id, {
        resolve: (response) => {
          signal?.removeEventListener("abort", cancel);
          resolve(responseResult(response));
        },
        reject: (error) => {
          signal?.removeEventListener("abort", cancel);
          reject(error);
        },
      });
      this.socket.write(`${line}\n`, (error) => {
        if (error !== undefined && error !== null) {
          this.#pending.delete(id);
          signal?.removeEventListener("abort", cancel);
          reject(
            new HeniekClientError("DAEMON_UNAVAILABLE", "Heniek daemon is not reachable.", true),
          );
        }
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_LINE_BYTES) {
      this.close();
      this.rejectAll(
        new HeniekClientError(
          "RPC_FAILURE",
          "The Heniek daemon sent an oversized response.",
          false,
        ),
      );
      return;
    }
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.close();
        this.rejectAll(
          new HeniekClientError(
            "RPC_FAILURE",
            "The Heniek daemon sent a malformed response.",
            false,
          ),
        );
        return;
      }
      if (
        !isRecord(value) ||
        value.jsonrpc !== JSON_RPC_VERSION ||
        (typeof value.id !== "number" && typeof value.id !== "string" && value.id !== null)
      ) {
        this.close();
        this.rejectAll(
          new HeniekClientError(
            "RPC_FAILURE",
            "The Heniek daemon sent a malformed response.",
            false,
          ),
        );
        return;
      }
      const response = value as unknown as Response;
      if (typeof response.id !== "number") {
        continue;
      }
      const pending = this.#pending.get(response.id);
      if (pending !== undefined) {
        this.#pending.delete(response.id);
        pending.resolve(response);
      }
    }
  }

  private rejectAll(
    error = new HeniekClientError("DAEMON_UNAVAILABLE", "Heniek daemon is not reachable.", true),
  ): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

async function readCredential(home: ApplicationHome): Promise<DaemonCredential> {
  const store = createFileSecretStore({ directory: home.paths.secretsDirectory });
  const value = await store.read("daemon.local-control");
  const credential = value === undefined ? undefined : credentialFromPersisted(value.expose());
  if (credential === undefined) {
    throw new HeniekClientError(
      "AUTHENTICATION_FAILED",
      "Heniek daemon credentials are unavailable.",
      true,
    );
  }
  return credential;
}

async function authenticatedOnce<T>(
  home: ApplicationHome,
  requirement: RpcRequirement,
  params: Record<string, unknown>,
  parse: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<{
  readonly result: T;
  readonly daemonVersion: number;
  readonly daemonManifestVersion: string;
}> {
  const client = await LineClient.connect(home.paths.daemonSocketFile);
  let credential: DaemonCredential | undefined;
  try {
    const hello = parseHello(await client.request(DAEMON_HELLO_METHOD));
    if (hello.protocolVersion !== TRANSPORT_VERSION) {
      throw new HeniekClientError(
        "INCOMPATIBLE_PROTOCOL",
        "Heniek daemon protocol is incompatible.",
        false,
        { daemonVersion: hello.protocolVersion },
      );
    }
    credential = await readCredential(home);
    if (credential.keyId !== hello.keyId) {
      throw new HeniekClientError(
        "AUTHENTICATION_FAILED",
        "Heniek daemon restarted during authentication.",
        true,
      );
    }
    const challenge = new Uint8Array(Buffer.from(hello.challenge, "hex"));
    const negotiation = parseNegotiation(
      await client.request(
        DAEMON_NEGOTIATE_METHOD,
        {
          schemaVersion: 1,
          transportVersions: [TRANSPORT_VERSION],
          requiredMethods: [
            {
              name: requirement.name,
              methodVersions: [1],
              resultSchemas: [{ schemaId: requirement.schemaId, sha256: requirement.sha256 }],
            },
          ],
        },
        credential,
        challenge,
      ),
      requirement,
    );
    return {
      result: parse(
        await client.request(requirement.wireMethod, params, credential, challenge, signal),
      ),
      daemonVersion: hello.protocolVersion,
      daemonManifestVersion: negotiation.manifestVersion,
    };
  } finally {
    if (credential !== undefined) {
      zeroCredential(credential);
    }
    client.close();
  }
}

async function once(home: ApplicationHome, signal?: AbortSignal): Promise<StatusSnapshot> {
  const snapshot = await authenticatedOnce(home, STATUS_REQUIREMENT, {}, parseStatus, signal);
  return {
    status: snapshot.result,
    daemonVersion: snapshot.daemonVersion,
    daemonManifestVersion: snapshot.daemonManifestVersion,
    schemaCompatibility: "exact",
  };
}

export async function fetchDaemonStatus(
  home: ApplicationHome,
  options: { readonly signal?: AbortSignal } = {},
): Promise<StatusSnapshot> {
  try {
    return await once(home, options.signal);
  } catch (error) {
    if (
      error instanceof HeniekClientError &&
      error.code === "AUTHENTICATION_FAILED" &&
      error.retryable
    ) {
      return once(home, options.signal);
    }
    throw error;
  }
}

async function retryAuthentication<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof HeniekClientError &&
      error.code === "AUTHENTICATION_FAILED" &&
      error.retryable
    ) {
      return operation();
    }
    throw error;
  }
}

export async function detectCodebaseViaDaemon(
  home: ApplicationHome,
  roots: readonly string[],
  options: {
    readonly sourceRepositoryPath?: string | null;
    readonly signal?: AbortSignal;
  } = {},
): Promise<CodebaseDetectionResult> {
  return retryAuthentication(async () => {
    const response = await authenticatedOnce(
      home,
      DETECT_REQUIREMENT,
      {
        schemaVersion: 1,
        roots: [...roots],
        sourceRepositoryPath: options.sourceRepositoryPath ?? null,
      },
      parseDetection,
      options.signal,
    );
    return response.result;
  });
}

export async function registerCodebaseViaDaemon(
  home: ApplicationHome,
  input: {
    readonly roots: readonly string[];
    readonly expectedTopologySha256: string;
    readonly sourceRepositoryPath?: string | null;
  },
  options: { readonly signal?: AbortSignal } = {},
): Promise<RegisteredCodebase> {
  return retryAuthentication(async () => {
    const response = await authenticatedOnce(
      home,
      REGISTER_REQUIREMENT,
      {
        schemaVersion: 1,
        roots: [...input.roots],
        sourceRepositoryPath: input.sourceRepositoryPath ?? null,
        expectedTopologySha256: input.expectedTopologySha256,
        confirmed: true,
      },
      parseRegistration,
      options.signal,
    );
    return response.result;
  });
}
