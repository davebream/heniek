/**
 * Local control credential minting and storage (design C5, plan Task 3 Step
 * 7). `mintCredential` is pure over the injected `RandomSource` — the
 * cryptography built-in's random-byte generator belongs only in
 * `src/runtime/random-source.ts` (Phase 5), never here. Persistence goes
 * through the already-injected `SecretStore` port `@heniek/secrets`
 * provides; this module never touches a filesystem built-in itself.
 *
 * **Rotation trigger:** a fresh secret on every daemon start (STD-11 —
 * session secrets "SHOULD NOT be persistent… across a restart"), plus
 * removal on clean shutdown. There is no rotation RPC — `daemon.rotateCredential`
 * was withdrawn (plan-review round 2, finding 13; design `## Alternatives
 * Considered` row S) — and rotation is deliberately never interval-based:
 * an interval needs `setInterval`, banned by C10, and buys nothing for a
 * secret that lives exactly as long as the process that minted it.
 *
 * The secret crosses this module's boundary only as raw bytes held in
 * memory for the process lifetime and as a `SensitiveValue` the moment it
 * is handed to the store — it never appears in an error, a diagnostic, a
 * trace line, or a `DaemonStatus` payload.
 */

import type { SecretStore } from "@heniek/secrets";
import { SensitiveValue } from "@heniek/secrets";
import type { RandomSource } from "../ports.js";
import { bytesToHex } from "./verify.js";

/**
 * Entry name under which the credential is persisted — valid against
 * `SECRET_ENTRY_NAME_PATTERN` (`packages/secrets/src/store.ts:27`).
 */
export const CREDENTIAL_ENTRY_NAME = "daemon.local-control";

/** 256-bit secret — 4x NIST's 64-bit floor (STD-11). */
export const CREDENTIAL_SECRET_BYTES = 32;
/** 16-byte opaque key id, carried on the wire (`DaemonHelloResult/v1.keyId`) so a client learns which key it is about to authenticate against. */
export const CREDENTIAL_KEY_ID_BYTES = 16;

export interface DaemonCredential {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

export function mintCredential(randomSource: RandomSource): DaemonCredential {
  return {
    keyId: bytesToHex(randomSource.bytes(CREDENTIAL_KEY_ID_BYTES)),
    secret: randomSource.bytes(CREDENTIAL_SECRET_BYTES),
  };
}

/** The persisted form: `<keyId>.<secretHex>` — never logged, never returned from any RPC, read back by nothing in Q008 (there is no rotation RPC and no other consumer). */
function serialiseCredential(credential: DaemonCredential): string {
  return `${credential.keyId}.${bytesToHex(credential.secret)}`;
}

export async function persistCredential(
  secretStore: SecretStore,
  credential: DaemonCredential,
): Promise<void> {
  await secretStore.write(
    CREDENTIAL_ENTRY_NAME,
    SensitiveValue.from(serialiseCredential(credential)),
  );
}

/** Removed on clean shutdown (design C5/C9) — never on a crash path, since a `SIGKILL` cannot run it. */
export async function removeCredential(secretStore: SecretStore): Promise<boolean> {
  return secretStore.remove(CREDENTIAL_ENTRY_NAME);
}
