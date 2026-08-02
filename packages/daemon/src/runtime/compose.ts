/**
 * The single composition root (design C10, plan Task 5 Steps 6 and 8) for
 * the RPC/auth path: it is the one place that wires `src/rpc/codec.ts`'s
 * pure decoder, `src/rpc/dispatch.ts`'s pure dispatcher, and
 * `src/auth/challenge.ts`'s per-connection state together with a real
 * accepted connection from `src/runtime/socket-server.ts`.
 *
 * `attachDaemonRpcServer` narrows `BoundSocket.onConnection`'s `unknown`
 * argument back to `socket-server.ts`'s `RawConnection` — the private
 * contract between these two runtime files that lets `ports.ts` keep the
 * public port surface free of any built-in socket type (see
 * `socket-server.ts`'s docblock).
 *
 * The full daemon startup sequence — claim → probe → reclaim → open DB →
 * migrate → recover → classify → bind → publish → attach handler — is a
 * later phase's concern (design's `## Approach`); this composition root
 * covers exactly the slice Phase 5 needs to prove end-to-end: a real
 * connection, framed by the real codec, authenticated by the real MAC
 * provider, dispatched through the real registry.
 *
 * **Per-connection frames are processed strictly in arrival order.**
 * `dispatchFrame` is async (a handler may itself be async), so two frames
 * decoded from the same or successive chunks are chained onto one promise
 * queue rather than dispatched concurrently — otherwise a slow handler for
 * an earlier request could let a later response overtake it on the wire,
 * which no JSON-RPC client expects from a single connection.
 */

import { mintConnectionAuthState } from "../auth/challenge.js";
import type { AuthenticatedCredential } from "../auth/verify.js";
import type { BoundSocket, MacProvider, RandomSource } from "../ports.js";
import { createCodec, type Frame } from "../rpc/codec.js";
import type { DispatchDeps } from "../rpc/dispatch.js";
import { dispatchFrame } from "../rpc/dispatch.js";
import type { MethodRegistry } from "../rpc/methods.js";
import type { RawConnection } from "./socket-server.js";

export interface ConnectionHandlerDeps {
  readonly randomSource: RandomSource;
  readonly macProvider: MacProvider;
  readonly credential: AuthenticatedCredential;
  readonly registry: MethodRegistry;
  readonly instanceId: string;
  readonly protocolVersion: number;
  readonly isDraining: () => boolean;
  readonly onHandlerError?: (method: string, error: unknown) => void;
}

const textEncoder = new TextEncoder();

/**
 * Builds the per-connection frame handler: mints a fresh challenge
 * (`mintConnectionAuthState`), decodes incoming bytes with a fresh codec
 * instance, dispatches each frame, writes the response line back, and — the
 * moment the connection's `lastSequence` first advances past `0`, meaning
 * `verifyRequest` accepted at least one authenticated request — calls
 * `connection.markAuthenticated()` exactly once, freeing this connection's
 * slot in `socket-server.ts`'s unauthenticated sub-cap.
 */
export function createConnectionHandler(
  deps: ConnectionHandlerDeps,
): (connection: unknown) => void {
  return (rawConnection: unknown): void => {
    const connection = rawConnection as RawConnection;
    const authState = mintConnectionAuthState(deps.randomSource);
    const decode = createCodec();
    let hasMarkedAuthenticated = false;
    let queue: Promise<void> = Promise.resolve();

    const dispatchDeps: DispatchDeps = {
      registry: deps.registry,
      credential: deps.credential,
      macProvider: deps.macProvider,
      instanceId: deps.instanceId,
      protocolVersion: deps.protocolVersion,
      isDraining: deps.isDraining,
      // `exactOptionalPropertyTypes` forbids assigning a possibly-`undefined`
      // value to an optional property — the property must be *absent*, not
      // present-with-`undefined`, when the caller did not supply a handler.
      ...(deps.onHandlerError !== undefined ? { onHandlerError: deps.onHandlerError } : {}),
    };

    async function processFrame(frame: Frame): Promise<void> {
      const line = await dispatchFrame(dispatchDeps, authState, frame);
      connection.write(textEncoder.encode(line));

      if (!hasMarkedAuthenticated && authState.lastSequence > 0) {
        hasMarkedAuthenticated = true;
        connection.markAuthenticated();
      }

      if (frame.kind === "error" && frame.fatal) {
        connection.destroy();
      }
    }

    connection.onData((chunk: Uint8Array) => {
      for (const frame of decode(chunk)) {
        queue = queue.then(() => processFrame(frame));
      }
    });
  };
}

/** Wires `createConnectionHandler`'s output onto a real bound socket. */
export function attachDaemonRpcServer(socket: BoundSocket, deps: ConnectionHandlerDeps): void {
  socket.onConnection(createConnectionHandler(deps));
}
