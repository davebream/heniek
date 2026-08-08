import { createHmac } from "node:crypto";

export const JSON_RPC_VERSION = "2.0";
export const TRANSPORT_VERSION = 1;
export const MAX_LINE_BYTES = 64 * 1024;

export const DAEMON_HELLO_METHOD = "daemon.hello";
export const DAEMON_NEGOTIATE_METHOD = "daemon.negotiate";
export const DAEMON_STATUS_METHOD = "daemon.status";
export const DAEMON_STATUS_V1_METHOD = "daemon.status.v1";
export const DAEMON_RECOVERY_METHOD = "daemon.recovery";
export const DAEMON_RECOVERY_V1_METHOD = "daemon.recovery.v1";
export const CODEBASE_DETECT_METHOD = "codebase.detect";
export const CODEBASE_DETECT_V1_METHOD = "codebase.detect.v1";
export const CODEBASE_REGISTER_METHOD = "codebase.register";
export const CODEBASE_REGISTER_V1_METHOD = "codebase.register.v1";
export const STAGE_START_METHOD = "stage.start";
export const STAGE_START_V1_METHOD = "stage.start.v1";
export const RUN_STATUS_METHOD = "run.status";
export const RUN_STATUS_V1_METHOD = "run.status.v1";
export const RUN_STATUS_V2_METHOD = "run.status.v2";
export const RUN_ANSWER_METHOD = "run.answer";
export const RUN_ANSWER_V1_METHOD = "run.answer.v1";
export const RUN_ANSWER_V2_METHOD = "run.answer.v2";
export const RUN_RESUME_METHOD = "run.resume";
export const RUN_RESUME_V1_METHOD = "run.resume.v1";
export const RUN_RESUME_V2_METHOD = "run.resume.v2";
export const INBOX_LIST_METHOD = "inbox.list";
export const INBOX_LIST_V1_METHOD = "inbox.list.v1";
export const RUN_CANCEL_METHOD = "run.cancel";
export const RUN_CANCEL_V1_METHOD = "run.cancel.v1";
export const RUN_RESULT_METHOD = "run.result";
export const RUN_RESULT_V1_METHOD = "run.result.v1";
export const ARTIFACT_GET_METHOD = "artifact.get";
export const ARTIFACT_GET_V1_METHOD = "artifact.get.v1";
export const DOCTOR_METHOD = "doctor";
export const DOCTOR_V1_METHOD = "doctor.v1";
export const ENGINE_CATALOGUE_METHOD = "engine.catalogue";
export const ENGINE_CATALOGUE_V1_METHOD = "engine.catalogue.v1";
export const RPC_CANCEL_METHOD = "rpc.cancel";

export const ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  draining: -32000,
  unauthorized: -32001,
  requestCancelled: -32002,
  protocolNotNegotiated: -32003,
} as const;

export const ERROR_MESSAGES = {
  draining: "draining",
  unauthorized: "unauthorized",
  requestCancelled: "request cancelled",
  protocolNotNegotiated: "protocol not negotiated",
} as const;

export type JsonRpcId = string | number;

export interface DaemonCredential {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

export interface NegotiatedMethodV1 {
  readonly name: string;
  readonly methodVersion: number;
  readonly wireMethod: string;
  readonly resultSchemaId: string;
  readonly resultSchemaSha256: string;
}

export const DAEMON_STATUS_SCHEMA_ID = "heniek://contract/DaemonStatus/v1";
export const DAEMON_STATUS_SCHEMA_SHA256 =
  "a91375e3509ceb2663a96e656d18e32c722085a1cb574328159cee7ff4fef854";
export const DAEMON_RECOVERY_SCHEMA_ID = "heniek://contract/DaemonRecoveryResult/v1";
export const DAEMON_RECOVERY_SCHEMA_SHA256 =
  "8c4099c58b018a809e8708451e33ccdc4e24fa74fb65865d35953af9f3672e9a";
export const CODEBASE_DETECTION_SCHEMA_ID = "heniek://contract/CodebaseDetectionResult/v1";
export const CODEBASE_DETECTION_SCHEMA_SHA256 =
  "0ff6101822ed1ba516ea106ace09d8a6f15fd5c8c8a605bf6b788cb43355b210";
export const REGISTERED_CODEBASE_SCHEMA_ID = "heniek://contract/RegisteredCodebase/v1";
export const REGISTERED_CODEBASE_SCHEMA_SHA256 =
  "46aaf927a7b496d3da5b4c438c2f49ab7c6638363384cb0d6aca61fa0258b10f";
export const STAGE_START_SCHEMA_ID = "heniek://contract/StageStartResult/v1";
export const STAGE_START_SCHEMA_SHA256 =
  "35776620780b4a150ab249801125096c4edfd9bfb8713c5c3e57e3d41c616341";
export const RUN_STATUS_SCHEMA_ID = "heniek://contract/StageRunStatusResult/v1";
export const RUN_STATUS_SCHEMA_SHA256 =
  "69c0bd03d97d24dab4ee7b8b552b224ec23ddc5536db25e08bdd70b82a88fc79";
export const RUN_STATUS_V2_SCHEMA_ID = "heniek://contract/StageRunStatusResult/v2";
export const RUN_STATUS_V2_SCHEMA_SHA256 =
  "f9d6117ced1e9ecf64569e2a15285e13999d0d67cd28e83f6b909a7df0c15601";
export const RUN_MUTATION_SCHEMA_ID = "heniek://contract/StageRunMutationResult/v1";
export const RUN_MUTATION_SCHEMA_SHA256 =
  "7491e0d1842751707d3658b7c71c058f1d2a6b1194d8c6752511b8293f1c9e3b";
export const RUN_ANSWER_V2_SCHEMA_ID = "heniek://contract/StageRunAnswerResult/v2";
export const RUN_ANSWER_V2_SCHEMA_SHA256 =
  "f2a8f8fc1020ec5371e769db12fe0aeaca865caa669077d7c35167a29efc265c";
export const RUN_RESUME_V2_SCHEMA_ID = "heniek://contract/StageRunResumeResult/v2";
export const RUN_RESUME_V2_SCHEMA_SHA256 =
  "39164d439fdce631fadae6a7baa7ca926d6c3fc76b76c25f8f9411e6da65b4c7";
export const INBOX_LIST_SCHEMA_ID = "heniek://contract/InteractionInboxResult/v1";
export const INBOX_LIST_SCHEMA_SHA256 =
  "5df66ed00d0e1f61793299773df14d61885013e5d234bcb533f69d16bac04428";
export const RUN_RESULT_SCHEMA_ID = "heniek://contract/StageRunResult/v1";
export const RUN_RESULT_SCHEMA_SHA256 =
  "8f0faffeabe166f355b7033e9a45b6cf2bae829d1ab64ab10f086fce501fc8fa";
export const ARTIFACT_GET_SCHEMA_ID = "heniek://contract/ArtifactGetResult/v1";
export const ARTIFACT_GET_SCHEMA_SHA256 =
  "f7b3994c57cb536a8bcca368a33c38d24d5ffafaf60144ce3382e89a03d38223";
export const DOCTOR_SCHEMA_ID = "heniek://contract/DoctorReport/v1";
export const DOCTOR_SCHEMA_SHA256 =
  "1645c1a617331955c3a515bd3942e423e71e3fbc460093092fc149b0cee6e56c";
export const CAPABILITY_CATALOGUE_SCHEMA_ID = "heniek://contract/CapabilityCatalogue/v1";
export const CAPABILITY_CATALOGUE_SCHEMA_SHA256 =
  "5fe61be4e0fb222028c0078740e0b407250dddb911855a5dc14e15ed3a55a54c";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function authMessage(challenge: Uint8Array, sequence: number, canonical: string): Uint8Array {
  const suffix = new TextEncoder().encode(`\n${sequence}\n${canonical}`);
  const message = new Uint8Array(challenge.length + suffix.length);
  message.set(challenge);
  message.set(suffix, challenge.length);
  return message;
}

/** Builds the one canonical request spelling this client emits. */
export function buildSignedRequest(
  credential: DaemonCredential,
  challenge: Uint8Array,
  id: JsonRpcId,
  method: string,
  sequence: number,
  params: Readonly<Record<string, unknown>> = {},
): string {
  const canonical = JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method, params });
  const mac = createHmac("sha256", credential.secret)
    .update(authMessage(challenge, sequence, canonical))
    .digest("hex");
  return JSON.stringify({
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
    params: {
      ...params,
      auth: { schemaVersion: 1, keyId: credential.keyId, sequence, mac },
    },
  });
}

export function encodeRequest(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

export function zeroCredential(credential: DaemonCredential): void {
  credential.secret.fill(0);
}

export function credentialFromPersisted(value: string): DaemonCredential | undefined {
  const match = /^([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(value);
  if (match === null) {
    return undefined;
  }
  const keyId = match[1];
  const secretHex = match[2];
  if (keyId === undefined || secretHex === undefined) {
    return undefined;
  }
  return { keyId, secret: new Uint8Array(Buffer.from(secretHex, "hex")) };
}

export function toHex(bytes: Uint8Array): string {
  return hex(bytes);
}
