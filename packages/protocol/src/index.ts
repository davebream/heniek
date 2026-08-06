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
  readonly name: "daemon.status" | "daemon.recovery";
  readonly methodVersion: 1;
  readonly wireMethod: "daemon.status.v1" | "daemon.recovery.v1";
  readonly resultSchemaId: string;
  readonly resultSchemaSha256: string;
}

export const DAEMON_STATUS_SCHEMA_ID = "heniek://contract/DaemonStatus/v1";
export const DAEMON_STATUS_SCHEMA_SHA256 =
  "a91375e3509ceb2663a96e656d18e32c722085a1cb574328159cee7ff4fef854";
export const DAEMON_RECOVERY_SCHEMA_ID = "heniek://contract/DaemonRecoveryResult/v1";
export const DAEMON_RECOVERY_SCHEMA_SHA256 =
  "8c4099c58b018a809e8708451e33ccdc4e24fa74fb65865d35953af9f3672e9a";

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
