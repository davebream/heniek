/**
 * Real-socket coverage for the `src/runtime/**` networking adapters (design
 * C2/C7/C8, plan Task 5 Steps 2, 2b, 2d).
 *
 * `test/probe.test.ts` already proves `classifyProbeOutcome` (the pure
 * classifier) against every `ProbeAttemptOutcome`; this file proves the
 * **adapter** — `createNodeSocketProbe` — actually observes the right
 * `ProbeAttemptOutcome` for a given real-world condition on a real Unix
 * domain socket. Likewise `test/dispatch.test.ts` already proves
 * `dispatchFrame` against fabricated frames; this file's socket-level
 * section (plan-review round 1 reviewer B, finding M3) proves the
 * **wiring** in `src/runtime/compose.ts` actually installs the verifier —
 * a `compose.ts` that forgot to would pass every one of those fabricated-
 * frame tests and still ship a bypass.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintCredential } from "../src/auth/credential.js";
import {
  type AuthenticatedCredential,
  buildAuthMacMessage,
  bytesToHex,
} from "../src/auth/verify.js";
import type { BoundSocket, MacProvider, RandomSource } from "../src/ports.js";
import { ERROR_CODES } from "../src/rpc/codec.js";
import { createMethodRegistry, DAEMON_STATUS_METHOD } from "../src/rpc/methods.js";
import { attachDaemonRpcServer } from "../src/runtime/compose.js";
import { createHmacSha256MacProvider } from "../src/runtime/mac.js";
import { createSystemRandomSource } from "../src/runtime/random-source.js";
import { createNodeSocketProbe } from "../src/runtime/socket-probe.js";
import {
  createNodeSocketBinder,
  MAX_CONCURRENT_CONNECTIONS,
  MAX_UNAUTHENTICATED_CONNECTIONS,
  type SocketServerOptions,
} from "../src/runtime/socket-server.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "heniek-daemon-runtime-socket-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// createNodeSocketProbe — the four verdicts, adapter-level (design C2)
// ---------------------------------------------------------------------------

describe("createNodeSocketProbe — adapter-level verdicts (design C2, plan Task 5 Step 2)", () => {
  it("absent — nothing exists at the path", async () => {
    const probe = createNodeSocketProbe();
    const verdict = await probe.probe(join(home, "nothing-here.sock"));
    expect(verdict).toBe("absent");
  });

  it("no-listener — a socket inode with no listener behind it (ECONNREFUSED)", async () => {
    const path = join(home, "orphan.sock");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
const net = require("node:net");
const server = net.createServer();
server.listen(process.argv[1], () => { process.stdout.write("ready\\n"); });
setInterval(() => {}, 1000);
`,
        path,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await new Promise<void>((resolve) => {
        child.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("ready")) {
            resolve();
          }
        });
      });
      expect(existsSync(path)).toBe(true);

      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      // A SIGKILL never runs any cleanup handler, so the socket inode
      // survives — exactly the stale-socket condition design C1 step 3
      // reclaims.
      expect(existsSync(path)).toBe(true);

      const probe = createNodeSocketProbe();
      const verdict = await probe.probe(path);
      expect(verdict).toBe("no-listener");
    } finally {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
  });

  it("hostile — permission denied connecting to the path (EACCES)", async () => {
    const path = join(home, "denied.sock");
    const binder = createNodeSocketBinder();
    const bound = await binder.listen(path);
    try {
      chmodSync(path, 0o000);
      const probe = createNodeSocketProbe();
      const verdict = await probe.probe(path);
      expect(verdict).toBe("hostile");
    } finally {
      chmodSync(path, 0o600);
      await bound.close();
    }
  });

  it("hostile — an unrecognised errno never reaches no-listener or absent (plan-review round 1 reviewer B, finding MINOR 4)", async () => {
    // A path far longer than `sizeof(sockaddr_un.sun_path)` fails at
    // connect() with a platform errno that is none of ECONNREFUSED/ENOENT
    // /EACCES — exactly the "anything unlisted" case the mapping must fold
    // into `hostile`, never into a verdict that authorises an unlink.
    const overlong = join(home, `${"a".repeat(400)}.sock`);
    const probe = createNodeSocketProbe();
    const verdict = await probe.probe(overlong);
    expect(verdict).toBe("hostile");
  });

  it("hostile — accept then close, no bytes ever sent", async () => {
    const path = join(home, "accept-close.sock");
    const server = createNodeSocketBinder();
    const bound = await server.listen(path);
    bound.onConnection((connection) => {
      (connection as { destroy(): void }).destroy();
    });
    try {
      const probe = createNodeSocketProbe();
      const verdict = await probe.probe(path);
      expect(verdict).toBe("hostile");
    } finally {
      await bound.close();
    }
  });

  it("hostile — a malformed line", async () => {
    const path = join(home, "malformed.sock");
    const bound = await createNodeSocketBinder().listen(path);
    bound.onConnection((connection) => {
      const raw = connection as {
        write(bytes: Uint8Array): void;
      };
      raw.write(new TextEncoder().encode("not json at all\n"));
    });
    try {
      const probe = createNodeSocketProbe();
      const verdict = await probe.probe(path);
      expect(verdict).toBe("hostile");
    } finally {
      await bound.close();
    }
  });

  it("hostile — an oversize line with no newline before the cap", async () => {
    const path = join(home, "oversize.sock");
    const bound = await createNodeSocketBinder().listen(path);
    bound.onConnection((connection) => {
      const raw = connection as { write(bytes: Uint8Array): void };
      raw.write(new TextEncoder().encode("a".repeat(70_000)));
    });
    try {
      const probe = createNodeSocketProbe();
      const verdict = await probe.probe(path);
      expect(verdict).toBe("hostile");
    } finally {
      await bound.close();
    }
  });

  it("hostile — the peer closes before any line arrives", async () => {
    const path = join(home, "partial-close.sock");
    const bound = await createNodeSocketBinder().listen(path);
    bound.onConnection((connection) => {
      const raw = connection as { write(bytes: Uint8Array): void; destroy(): void };
      raw.write(new TextEncoder().encode("partial-with-no-newline"));
      raw.destroy();
    });
    try {
      const probe = createNodeSocketProbe();
      const verdict = await probe.probe(path);
      expect(verdict).toBe("hostile");
    } finally {
      await bound.close();
    }
  });

  it("serving — a well-formed DaemonHelloResult/v1 response from an assembled daemon", async () => {
    const daemon = await startAssembledDaemon(home);
    try {
      const probe = createNodeSocketProbe();
      const verdict = await probe.probe(daemon.path);
      expect(verdict).toBe("serving");
    } finally {
      await daemon.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Shared assembled-daemon harness (plan Task 5 Steps 2b and 2d)
// ---------------------------------------------------------------------------

interface AssembledDaemon {
  readonly path: string;
  readonly instanceId: string;
  readonly credential: AuthenticatedCredential;
  readonly macProvider: MacProvider;
  readonly randomSource: RandomSource;
  readonly bound: BoundSocket;
  close(): Promise<void>;
}

async function startAssembledDaemon(
  directory: string,
  options?: SocketServerOptions,
): Promise<AssembledDaemon> {
  const path = join(directory, "daemon.sock");
  const macProvider = createHmacSha256MacProvider();
  const randomSource = createSystemRandomSource();
  const credential = mintCredential(randomSource);
  const instanceId = "assembled-daemon-instance";
  const registry = createMethodRegistry([
    [DAEMON_STATUS_METHOD, () => ({ schemaVersion: 1, ok: true })],
  ]);

  const bound = await createNodeSocketBinder(options).listen(path);
  attachDaemonRpcServer(bound, {
    randomSource,
    macProvider,
    credential,
    registry,
    instanceId,
    protocolVersion: 1,
    isDraining: () => false,
  });

  return {
    path,
    instanceId,
    credential,
    macProvider,
    randomSource,
    bound,
    close: () => bound.close(),
  };
}

/** A raw NDJSON line client: `send` writes one line and resolves with the next full response line. */
interface LineClient {
  readonly socket: Socket;
  send(line: string): Promise<string>;
  close(): void;
}

function connectLineClient(path: string): Promise<LineClient> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let buffer = "";
    const pending: Array<(line: string) => void> = [];

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const resolver = pending.shift();
        resolver?.(line);
        newlineIndex = buffer.indexOf("\n");
      }
    });
    socket.on("error", reject);
    socket.on("connect", () => {
      resolve({
        socket,
        send(line: string): Promise<string> {
          return new Promise((res) => {
            pending.push(res);
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

function signedRequestLine(
  daemon: AssembledDaemon,
  challenge: Uint8Array,
  id: number,
  method: string,
  sequence: number,
): string {
  const canonical = `{"jsonrpc":"2.0","id":${id},"method":"${method}","params":{}}`;
  const mac = bytesToHex(
    daemon.macProvider.hmacSha256(
      daemon.credential.secret,
      buildAuthMacMessage(challenge, sequence, canonical),
    ),
  );
  const auth = `{"schemaVersion":1,"keyId":"${daemon.credential.keyId}","sequence":${sequence},"mac":"${mac}"}`;
  return `{"jsonrpc":"2.0","id":${id},"method":"${method}","params":{"auth":${auth}}}`;
}

async function helloAndGetChallenge(client: LineClient): Promise<Uint8Array> {
  const line = await client.send('{"jsonrpc":"2.0","id":0,"method":"daemon.hello"}');
  const parsed = JSON.parse(line) as { result: { challenge: string } };
  return new Uint8Array(Buffer.from(parsed.result.challenge, "hex"));
}

// ---------------------------------------------------------------------------
// Socket-level authentication (plan Task 5 Step 2b, plan-review round 1
// reviewer B, finding M3 — "this closes the one genuine AC-2 coverage hole")
// ---------------------------------------------------------------------------

describe("assembled daemon over a real connection — authentication wiring (design C6/C8)", () => {
  it("daemon.hello succeeds pre-auth and returns a well-formed DaemonHelloResult/v1", async () => {
    const daemon = await startAssembledDaemon(home);
    const client = await connectLineClient(daemon.path);
    try {
      const line = await client.send('{"jsonrpc":"2.0","id":1,"method":"daemon.hello"}');
      const parsed = JSON.parse(line) as {
        result: {
          schemaVersion: number;
          protocolVersion: number;
          instanceId: string;
          challenge: string;
          macAlgorithm: string;
          keyId: string;
        };
      };
      expect(parsed.result.protocolVersion).toBe(1);
      expect(parsed.result.instanceId).toBe(daemon.instanceId);
      expect(parsed.result.challenge).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.result.macAlgorithm).toBe("hmac-sha256");
      expect(parsed.result.keyId).toBe(daemon.credential.keyId);
    } finally {
      client.close();
      await daemon.close();
    }
  });

  it("an unauthenticated daemon.status is byte-identical to an unauthenticated fabricated method — no method-existence oracle", async () => {
    const daemon = await startAssembledDaemon(home);
    const realMethodClient = await connectLineClient(daemon.path);
    const fabricatedMethodClient = await connectLineClient(daemon.path);
    try {
      await helloAndGetChallenge(realMethodClient);
      await helloAndGetChallenge(fabricatedMethodClient);

      const realLine = await realMethodClient.send(
        '{"jsonrpc":"2.0","id":2,"method":"daemon.status","params":{}}',
      );
      const fabricatedLine = await fabricatedMethodClient.send(
        '{"jsonrpc":"2.0","id":2,"method":"daemon.notARealMethod","params":{}}',
      );

      expect(realLine).toBe(fabricatedLine);
      const parsed = JSON.parse(realLine) as { error: { code: number; data?: unknown } };
      expect(parsed.error.code).toBe(ERROR_CODES.unauthorized);
      expect(parsed.error.data).toBeUndefined();
    } finally {
      realMethodClient.close();
      fabricatedMethodClient.close();
      await daemon.close();
    }
  });

  it("a captured authenticated frame replayed verbatim on a new connection is rejected with -32001", async () => {
    const daemon = await startAssembledDaemon(home);
    const firstClient = await connectLineClient(daemon.path);
    try {
      const challenge = await helloAndGetChallenge(firstClient);
      const capturedLine = signedRequestLine(daemon, challenge, 3, DAEMON_STATUS_METHOD, 1);

      const firstResponse = await firstClient.send(capturedLine);
      expect(JSON.parse(firstResponse)).toHaveProperty("result");

      // A brand-new connection has its own fresh challenge — the per-connection
      // state `verifyRequest` checks — so replaying the exact same signed
      // line captured against the first connection's challenge must fail:
      // this proves the challenge is really wired per connection, not
      // merely exercised by the pure core's own unit tests.
      const secondClient = await connectLineClient(daemon.path);
      try {
        await helloAndGetChallenge(secondClient);
        const replayedResponse = await secondClient.send(capturedLine);
        const parsed = JSON.parse(replayedResponse) as { error: { code: number } };
        expect(parsed.error.code).toBe(ERROR_CODES.unauthorized);
      } finally {
        secondClient.close();
      }
    } finally {
      firstClient.close();
      await daemon.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Connection caps (plan-review round 2, finding MINOR 5; plan Task 5 Step 2d)
// ---------------------------------------------------------------------------

describe("socket-server.ts — connection caps, assembled and in-process (plan Task 5 Step 2d)", () => {
  it("exports the documented default caps", () => {
    expect(MAX_CONCURRENT_CONNECTIONS).toBe(64);
    expect(MAX_UNAUTHENTICATED_CONNECTIONS).toBe(16);
  });

  it("destroys a connection past the concurrent cap immediately, with zero bytes exchanged, and frees a slot on close", async () => {
    const daemon = await startAssembledDaemon(home, {
      maxConcurrentConnections: 3,
      maxUnauthenticatedConnections: 100,
    });
    const clients: LineClient[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        clients.push(await connectLineClient(daemon.path));
      }
      // All three remain open and functional.
      for (const client of clients) {
        const line = await client.send('{"jsonrpc":"2.0","id":1,"method":"daemon.hello"}');
        expect(JSON.parse(line)).toHaveProperty("result");
      }

      // The 4th is destroyed before it ever gets a byte.
      const rejected = createConnection({ path: daemon.path });
      let sawData = false;
      rejected.on("data", () => {
        sawData = true;
      });
      await new Promise<void>((resolve) => rejected.once("close", () => resolve()));
      expect(sawData).toBe(false);

      // Closing one of the original three frees a slot for a new connection.
      const first = clients.shift();
      first?.close();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const fifth = await connectLineClient(daemon.path);
      try {
        const line = await fifth.send('{"jsonrpc":"2.0","id":1,"method":"daemon.hello"}');
        expect(JSON.parse(line)).toHaveProperty("result");
      } finally {
        fifth.close();
      }
    } finally {
      for (const client of clients) {
        client.close();
      }
      await daemon.close();
    }
  });

  it("enforces the unauthenticated sub-cap independently of the concurrent cap, freed by authentication", async () => {
    const daemon = await startAssembledDaemon(home, {
      maxConcurrentConnections: 100,
      maxUnauthenticatedConnections: 2,
    });
    const parked: LineClient[] = [];
    try {
      // Two connections that never authenticate — parked at the sub-cap.
      for (let i = 0; i < 2; i++) {
        parked.push(await connectLineClient(daemon.path));
      }

      // A third, still-unauthenticated connection attempt is destroyed —
      // the sub-cap, not the (much larger) concurrent cap, is what stops it.
      const rejected = createConnection({ path: daemon.path });
      let sawData = false;
      rejected.on("data", () => {
        sawData = true;
      });
      await new Promise<void>((resolve) => rejected.once("close", () => resolve()));
      expect(sawData).toBe(false);

      // One parked connection authenticates, freeing its sub-cap slot.
      const [authenticating] = parked;
      if (authenticating === undefined) {
        throw new Error("expected a parked connection");
      }
      const challenge = await helloAndGetChallenge(authenticating);
      const authedLine = signedRequestLine(daemon, challenge, 9, DAEMON_STATUS_METHOD, 1);
      const authedResponse = await authenticating.send(authedLine);
      expect(JSON.parse(authedResponse)).toHaveProperty("result");

      // A new connection can now be accepted — an authenticated client is
      // never starved by connections parked at the unauthenticated sub-cap.
      const admitted = await connectLineClient(daemon.path);
      try {
        const line = await admitted.send('{"jsonrpc":"2.0","id":1,"method":"daemon.hello"}');
        expect(JSON.parse(line)).toHaveProperty("result");
      } finally {
        admitted.close();
      }
    } finally {
      for (const client of parked) {
        client.close();
      }
      await daemon.close();
    }
  });
});
