/**
 * A minimal real-socket JSON-RPC client for the out-of-process signal tests
 * (plan Task 6 Steps 5, 3b) — mirrors `test/runtime-socket.test.ts`'s
 * `connectLineClient`/`signedRequestLine` pattern, adapted to read the
 * daemon's minted credential back off disk (the daemon under test is a real
 * *spawned process*, so the parent never holds the credential in memory the
 * way `runtime-socket.test.ts`'s in-process assembled-daemon harness does).
 *
 * The MAC preimage is `challenge ‖ "\n" ‖ sequence ‖ "\n" ‖
 * canonicalRequestBytes` (design C6, `src/auth/verify.ts`). Building it
 * without a chicken-and-egg problem (the `mac` field cannot cover itself):
 * serialise the request with a same-length placeholder `mac`, canonicalise
 * that line (which excises the *entire* `auth` member, placeholder and
 * all), compute the real MAC over the canonical bytes, then re-serialise
 * with the real `mac` in place of the placeholder — the canonical bytes are
 * identical either way, since only a value *inside* the excised span ever
 * changes.
 */

import { createConnection, type Socket } from "node:net";
import { createFileSecretStore } from "@heniek/secrets";
import { canonicaliseRequest } from "../../src/auth/canonical.js";
import { CREDENTIAL_ENTRY_NAME } from "../../src/auth/credential.js";
import { buildAuthMacMessage, bytesToHex } from "../../src/auth/verify.js";
import { createHmacSha256MacProvider } from "../../src/runtime/mac.js";

const PLACEHOLDER_MAC = "0".repeat(64);

export interface DaemonCredentialOnDisk {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

/** Reads back the credential `startDaemon` minted and persisted (`src/auth/credential.ts:serialiseCredential`'s `<keyId>.<secretHex>` form). */
export async function readPersistedCredential(
  secretsDirectory: string,
): Promise<DaemonCredentialOnDisk> {
  const store = createFileSecretStore({ directory: secretsDirectory });
  const value = await store.read(CREDENTIAL_ENTRY_NAME);
  if (value === undefined) {
    throw new Error(`no persisted daemon credential found under ${secretsDirectory}`);
  }
  const [keyId, secretHex] = value.expose().split(".");
  if (keyId === undefined || secretHex === undefined) {
    throw new Error(
      "persisted daemon credential is not in the expected '<keyId>.<secretHex>' form",
    );
  }
  return { keyId, secret: new Uint8Array(Buffer.from(secretHex, "hex")) };
}

interface LineClient {
  send(line: string): Promise<string>;
  close(): void;
}

function connectLineClient(path: string): Promise<LineClient> {
  return new Promise((resolveClient, rejectClient) => {
    const socket: Socket = createConnection({ path });
    let buffer = "";
    const pending: Array<(line: string) => void> = [];

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        pending.shift()?.(line);
        newlineIndex = buffer.indexOf("\n");
      }
    });
    socket.on("error", rejectClient);
    socket.on("connect", () => {
      resolveClient({
        send(line: string): Promise<string> {
          return new Promise((resolveSend) => {
            pending.push(resolveSend);
            socket.write(`${line}\n`);
          });
        },
        close(): void {
          socket.destroy();
        },
      });
    });
  });
}

function buildSignedRequestLine(
  credential: DaemonCredentialOnDisk,
  challenge: Uint8Array,
  id: number,
  method: string,
  sequence: number,
): string {
  const macProvider = createHmacSha256MacProvider();
  const placeholderAuth = `{"schemaVersion":1,"keyId":${JSON.stringify(credential.keyId)},"sequence":${sequence},"mac":"${PLACEHOLDER_MAC}"}`;
  const placeholderLine = `{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)},"params":{"auth":${placeholderAuth}}}`;
  const canonical = canonicaliseRequest(placeholderLine) ?? placeholderLine;
  const mac = bytesToHex(
    macProvider.hmacSha256(credential.secret, buildAuthMacMessage(challenge, sequence, canonical)),
  );
  const realAuth = `{"schemaVersion":1,"keyId":${JSON.stringify(credential.keyId)},"sequence":${sequence},"mac":"${mac}"}`;
  return `{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)},"params":{"auth":${realAuth}}}`;
}

export interface DaemonStatusResult {
  readonly schemaVersion: number;
  readonly instanceId: string;
  readonly lifecycleState: string;
  readonly startedAt: string;
  readonly reconciliation: {
    readonly probed: number;
    readonly resumable: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly unknown: number;
  };
  readonly artifactRecovery: {
    readonly removedIncoming: number;
    readonly skippedIncoming: number;
    readonly unreferencedBlobs: number;
  };
}

/**
 * Connects to `socketPath`, performs `daemon.hello`, reads the credential
 * back off `secretsDirectory`, and issues one authenticated `daemon.status`
 * call — the real-connection proof that "connectable implies fully
 * recovered" (plan Task 6 Falsifiability): a client that connects
 * successfully must always observe `lifecycleState: "serving"` and a
 * populated `reconciliation` block.
 */
export async function fetchDaemonStatusOverSocket(
  socketPath: string,
  secretsDirectory: string,
): Promise<DaemonStatusResult> {
  const client = await connectLineClient(socketPath);
  try {
    const helloLine = await client.send('{"jsonrpc":"2.0","id":1,"method":"daemon.hello"}');
    const helloParsed = JSON.parse(helloLine) as { result: { challenge: string } };
    const challenge = new Uint8Array(Buffer.from(helloParsed.result.challenge, "hex"));

    const credential = await readPersistedCredential(secretsDirectory);
    const statusLine = buildSignedRequestLine(credential, challenge, 2, "daemon.status", 1);
    const statusResponse = await client.send(statusLine);
    const statusParsed = JSON.parse(statusResponse) as {
      result?: DaemonStatusResult;
      error?: unknown;
    };
    if (statusParsed.result === undefined) {
      throw new Error(`daemon.status returned an error: ${JSON.stringify(statusParsed.error)}`);
    }
    return statusParsed.result;
  } finally {
    client.close();
  }
}
