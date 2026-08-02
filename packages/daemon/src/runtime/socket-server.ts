/**
 * The real `SocketBinder` adapter (design C1/C7, plan Task 5 Steps 6 and 8)
 * — the package's one `node:net` **listening**-socket owner (the client
 * side lives in `src/runtime/socket-probe.ts`).
 *
 * No TCP listener, no named pipe, no `127.0.0.1` binding anywhere in this
 * package — `listen(path)` always binds a Unix domain socket at `path`.
 * `EADDRINUSE` on `listen` is surfaced unchanged so `src/lifecycle/acquire.ts`
 * can map it to `BindRaced` and release the claim **without unlinking
 * anything**. This module never binds-then-renames into place — a `rename`
 * over a live socket path would silently replace it out from under a
 * connected client. `close()` calls `server.close()`, which unlinks the
 * socket path Node itself created (STD-3; verified empirically — see the
 * evidence sidecar).
 *
 * Does **not** reference `net.BoundSocket` — that type landed in Node
 * v26.4.0 and is unavailable on the pinned Node 24 (STD-3); `BoundSocket`
 * below is this package's own, unrelated, port type.
 *
 * **Connection caps (plan-review round 2, finding MINOR 5):**
 * `MAX_CONCURRENT_CONNECTIONS` bounds the whole socket's worst-case
 * unauthenticated footprint; `MAX_UNAUTHENTICATED_CONNECTIONS` is a
 * sub-cap within it so a flood of connections that never authenticate
 * cannot occupy every slot and starve a legitimate client. A connection
 * past either cap is `destroy()`ed **immediately** — before this module
 * attaches a single `"data"` listener, so the composition root never gets
 * a chance to mint a challenge or read a byte from it. `RawConnection` is
 * this module's private wire to `src/runtime/compose.ts`: `ports.ts`'s
 * `BoundSocket.onConnection` deliberately types the callback argument as
 * `unknown` so the pure-facing port surface never names a built-in socket
 * type; `compose.ts` is the one other file, also under `src/runtime/**`,
 * that narrows it back to `RawConnection`.
 */

import { type BigIntStats, lstatSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import type { BoundSocket, SocketBinder } from "../ports.js";

export const MAX_CONCURRENT_CONNECTIONS = 64;
export const MAX_UNAUTHENTICATED_CONNECTIONS = 16;

export interface SocketServerOptions {
  readonly maxConcurrentConnections?: number;
  readonly maxUnauthenticatedConnections?: number;
}

/** The shape `src/runtime/compose.ts` narrows `BoundSocket.onConnection`'s `unknown` argument to. */
export interface RawConnection {
  onData(callback: (chunk: Uint8Array) => void): void;
  write(bytes: Uint8Array): void;
  onClose(callback: () => void): void;
  destroy(): void;
  /** Moves this connection out of the unauthenticated sub-cap bucket. Idempotent — a caller need not track whether it already called this. */
  markAuthenticated(): void;
}

/**
 * Wraps one accepted `net.Socket` as a `RawConnection`. `onAuthenticated`
 * fires at most once, the moment `markAuthenticated()` is first called;
 * `onClosed` fires at most once, on socket close, reporting whether the
 * connection had authenticated by then — together these two callbacks are
 * exactly what the caller's unauthenticated-sub-cap counter needs, without
 * this function knowing the counter exists.
 */
function wrapSocket(
  socket: Socket,
  callbacks: { readonly onAuthenticated: () => void; readonly onClosed: () => void },
): RawConnection {
  let authenticated = false;
  let closed = false;
  const dataCallbacks: Array<(chunk: Uint8Array) => void> = [];
  const closeCallbacks: Array<() => void> = [];

  function markClosed(): void {
    if (closed) {
      return;
    }
    closed = true;
    callbacks.onClosed();
    for (const callback of closeCallbacks) {
      callback();
    }
  }

  socket.on("data", (chunk: Buffer) => {
    for (const callback of dataCallbacks) {
      callback(new Uint8Array(chunk));
    }
  });
  socket.on("close", markClosed);
  // A transport-level error is followed by a `"close"` event on every
  // `net.Socket`, which is where this module's bookkeeping actually runs;
  // an unhandled `"error"` listener would otherwise crash the process.
  socket.on("error", () => undefined);

  return {
    onData(callback: (chunk: Uint8Array) => void): void {
      dataCallbacks.push(callback);
    },
    write(bytes: Uint8Array): void {
      if (!socket.destroyed) {
        socket.write(bytes);
      }
    },
    onClose(callback: () => void): void {
      closeCallbacks.push(callback);
    },
    destroy(): void {
      socket.destroy();
    },
    markAuthenticated(): void {
      if (authenticated) {
        return;
      }
      authenticated = true;
      callbacks.onAuthenticated();
    },
  };
}

export function createNodeSocketBinder(options: SocketServerOptions = {}): SocketBinder {
  const maxConcurrent = options.maxConcurrentConnections ?? MAX_CONCURRENT_CONNECTIONS;
  const maxUnauthenticated =
    options.maxUnauthenticatedConnections ?? MAX_UNAUTHENTICATED_CONNECTIONS;

  return {
    listen(path: string): Promise<BoundSocket> {
      return new Promise((resolve, reject) => {
        let settled = false;
        let connectionCount = 0;
        let unauthenticatedCount = 0;
        const connectionCallbacks: Array<(connection: unknown) => void> = [];

        const server = createServer((socket: Socket) => {
          if (connectionCount >= maxConcurrent || unauthenticatedCount >= maxUnauthenticated) {
            // Destroyed before a single listener is attached — no challenge
            // minted, no byte read or written (plan Task 5 Step 6).
            socket.destroy();
            return;
          }
          connectionCount += 1;
          unauthenticatedCount += 1;
          let wasAuthenticated = false;

          const connection = wrapSocket(socket, {
            onAuthenticated: () => {
              wasAuthenticated = true;
              unauthenticatedCount -= 1;
            },
            onClosed: () => {
              connectionCount -= 1;
              if (!wasAuthenticated) {
                unauthenticatedCount -= 1;
              }
            },
          });

          for (const callback of connectionCallbacks) {
            callback(connection);
          }
        });

        server.on("error", (error: unknown) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });

        server.listen(path, () => {
          if (settled) {
            return;
          }
          settled = true;
          let stat: BigIntStats;
          try {
            stat = lstatSync(path, { bigint: true });
          } catch (error) {
            reject(error);
            return;
          }
          resolve({
            dev: stat.dev,
            ino: stat.ino,
            close(): Promise<void> {
              return new Promise((resolveClose) => {
                server.close(() => resolveClose());
              });
            },
            onConnection(callback: (connection: unknown) => void): void {
              connectionCallbacks.push(callback);
            },
            onClose(callback: () => void): void {
              server.on("close", callback);
            },
          });
        });
      });
    },
  };
}
