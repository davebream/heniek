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
 * Authentication and request admission run synchronously in wire order;
 * ordinary handlers may complete out of order so the control-lane
 * `rpc.cancel` request can interrupt an in-flight handler.
 * `dispatchFrame` is async (a handler may itself be async), so two frames
 * decoded from the same or successive chunks are chained onto one promise
 * queue rather than dispatched concurrently — otherwise a slow handler for
 * an earlier request could let a later response overtake it on the wire,
 * which no JSON-RPC client expects from a single connection.
 */

import { dirname } from "node:path";
import {
  createNodeFileSystem as createCodebaseFileSystem,
  createNodeGitPort,
  createNodeHashPort,
  createRegistrationStatePort,
  detectCodebase,
  loadRegistrations,
  registerCodebase,
} from "@heniek/codebase";
import type { ApplicationHome } from "@heniek/config";
import type { ExecutionBackend } from "@heniek/contracts";
import { createFileSecretStore } from "@heniek/secrets";
import { openStateDatabase, runMigrations } from "@heniek/state";
import {
  createNodeOwnerLiveness,
  createWorkspaceService,
  createWorkspaceStateStore,
  type WorkspaceService,
} from "@heniek/workspace";
import { mintConnectionAuthState } from "../auth/challenge.js";
import {
  type DaemonCredential,
  mintCredential,
  persistCredential,
  removeCredential,
} from "../auth/credential.js";
import type { AuthenticatedCredential } from "../auth/verify.js";
import type { AcquireDeps, AcquireOptions } from "../lifecycle/acquire.js";
import { acquireClaim } from "../lifecycle/acquire.js";
import type { LockHandle } from "../lifecycle/guard.js";
import { createLifecycleTracer } from "../lifecycle/trace.js";
import type { BoundSocket, IdGenerator, MacProvider, RandomSource } from "../ports.js";
import { type ReconcileResult, reconcile } from "../recovery/reconcile.js";
import { createCodec, type Frame } from "../rpc/codec.js";
import type { DispatchDeps } from "../rpc/dispatch.js";
import { dispatchFrame } from "../rpc/dispatch.js";
import {
  CODEBASE_DETECT_V1_METHOD,
  CODEBASE_REGISTER_V1_METHOD,
  createMethodRegistry,
  DAEMON_RECOVERY_METHOD,
  DAEMON_RECOVERY_V1_METHOD,
  DAEMON_STATUS_METHOD,
  DAEMON_STATUS_V1_METHOD,
  type MethodRegistry,
} from "../rpc/methods.js";
import { createSystemClock } from "./clock.js";
import { createSystemHostWitness } from "./host-witness.js";
import { createNodeLockFileSystem } from "./lock-filesystem.js";
import { createHmacSha256MacProvider } from "./mac.js";
import { createSystemProcessLiveness } from "./process-liveness.js";
import { createSystemRandomSource } from "./random-source.js";
import { installSignalHandlers } from "./signals.js";
import { createNodeSocketProbe } from "./socket-probe.js";
import type { RawConnection } from "./socket-server.js";
import { createNodeSocketBinder } from "./socket-server.js";
import { createStderrTraceSink } from "./trace-sink.js";

export interface ConnectionHandlerDeps {
  readonly randomSource: RandomSource;
  readonly macProvider: MacProvider;
  readonly credential: AuthenticatedCredential;
  readonly registry: MethodRegistry;
  readonly instanceId: string;
  readonly protocolVersion: number;
  readonly isDraining: () => boolean;
  readonly onHandlerError?: (method: string, error: unknown) => void;
  /**
   * The held claim, when this handler is wired by `startDaemon` rather than
   * driven directly by a test with fabricated frames. Design's non-negotiable
   * ordering requires `assertStillHeld()` "on every accepted connection" —
   * this is the only point in the served lifetime something actively
   * re-checks the claim, since nothing else polls it while idle. Optional so
   * the Phase 5 assembled-daemon tests, which exercise this handler without
   * ever going through `acquireClaim`, are unaffected.
   */
  readonly guard?: LockHandle;
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

    // "on every accepted connection" (design's non-negotiable ordering) —
    // the one active re-check of the claim during the served lifetime.
    // `assertStillHeld()` already fires every registered `onLost` callback
    // before throwing, so a genuine loss is handled there (stop accepting,
    // exit non-zero); this catch only keeps a freshly-doomed connection from
    // ever being processed.
    if (deps.guard !== undefined) {
      try {
        deps.guard.assertStillHeld();
      } catch {
        connection.destroy();
        return;
      }
    }

    const authState = mintConnectionAuthState(deps.randomSource);
    const decode = createCodec();
    let hasMarkedAuthenticated = false;
    let closed = false;
    const active = new Map<string, AbortController>();
    const requestKey = (id: string | number): string => `${typeof id}:${id}`;

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
      createRequestContext: (id) => {
        const key = requestKey(id);
        if (active.has(key)) {
          return undefined;
        }
        const controller = new AbortController();
        active.set(key, controller);
        return { signal: controller.signal };
      },
      finishRequest: (id) => {
        active.delete(requestKey(id));
      },
      cancelRequest: (id) => {
        const controller = active.get(requestKey(id));
        if (controller === undefined || controller.signal.aborted) {
          return false;
        }
        controller.abort();
        return true;
      },
    };

    async function processFrame(frame: Frame): Promise<void> {
      const line = await dispatchFrame(dispatchDeps, authState, frame);
      if (!closed) {
        connection.write(textEncoder.encode(line));
      }

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
        void processFrame(frame);
      }
    });
    connection.onClose(() => {
      closed = true;
      for (const controller of active.values()) {
        controller.abort();
      }
      active.clear();
    });
  };
}

/** Wires `createConnectionHandler`'s output onto a real bound socket. */
export function attachDaemonRpcServer(socket: BoundSocket, deps: ConnectionHandlerDeps): void {
  socket.onConnection(createConnectionHandler(deps));
}

// ---------------------------------------------------------------------------
// startDaemon — the full composition root (design C1/C9/C10, plan Task 6
// Step 8). The mandated order:
//
//   claim -> probe -> reclaim -> open DB -> migrate -> recover -> classify
//     -> bind -> publish -> attach handler
//
// `acquireClaim` (Phase 2, extended this phase) already performs claim,
// probe, and reclaim, then — strictly before it ever calls `SocketBinder.
// listen()` — invokes the `recover` hook below, which is where this
// function opens the owned state database, migrates it, and runs the
// restart-reconciliation pass (`reconcile()`, C11/C12) while still holding
// the claim. Only once that hook resolves does `acquireClaim` bind and
// publish. The credential is minted inside that same hook, so it too is
// fresh before `listen()` is ever called. The connection handler is
// attached last, after `acquireClaim` has already returned "acquired" —
// this is what makes "connectable implies fully recovered" hold: nothing
// can complete a request against this daemon before every step above it
// has already run.
// ---------------------------------------------------------------------------

export interface StartDaemonDeps {
  readonly home: ApplicationHome;
  /**
   * Q008 ships no Claudexor adapter (design's `## Approach`) — the caller
   * supplies whatever `ExecutionBackend` this daemon should reconcile
   * against.
   */
  readonly backend: ExecutionBackend;
  /** Defaults to `1`. */
  readonly protocolVersion?: number;
  /**
   * Optional coordination hook invoked once draining begins — after the
   * trace has already recorded `serving -> draining` but strictly before
   * the socket is closed — and awaited before the drain proceeds any
   * further (plan Task 6 Step 3b). Lets a caller hold the
   * "draining-but-still-bound" window open for an external synchronisation
   * point: `daemon.hello` remains answerable throughout the drain (design
   * C9's exemption), so a concurrent starter's probe genuinely can observe
   * `serving` and concede rather than refuse — but only if the socket is
   * still listening at the instant that probe runs. Without this hook the
   * window between `draining = true` and `server.close()` is a single
   * synchronous step with no externally observable gap (verified
   * empirically — `server.close()` on a Unix domain socket stops accepting
   * and unlinks the path before any other code can run), so a test cannot
   * otherwise arrange to land its probe inside it. Defaults to an immediate
   * resolve; production callers never need to supply it.
   */
  readonly onDraining?: () => Promise<void> | void;
}

export type StartDaemonOutcome =
  | {
      readonly kind: "serving";
      readonly instanceId: string;
      /** In-process workspace capability; Q011 deliberately adds no wire method. */
      readonly workspaceService: WorkspaceService;
      /**
       * Resolves once a graceful drain (a SIGTERM/SIGINT the caller wires
       * through `requestDrain`, or a direct `requestDrain()` call) has fully
       * unwound the socket, the claim, and the credential. The caller should
       * exit 0 immediately afterward.
       */
      readonly stopped: Promise<void>;
      /** Begins the same graceful drain a first SIGTERM would (design C9). */
      readonly requestDrain: () => void;
    }
  | {
      readonly kind: "exited";
      /** `10` conceded, `11` refused, `12` recovery failure — `0` never appears here (a clean exit only ever happens after `"serving"`, via `stopped`). */
      readonly exitCode: 10 | 11 | 12;
      readonly error: Error;
    };

/**
 * A minimal `IdGenerator` (`@heniek/state`'s port, re-exported by
 * `../ports.js`) built from the already-injected `RandomSource` rather than
 * a twelfth `src/runtime/**` file — `@heniek/state` ships no default
 * implementation of its own determinism ports, and this is the one
 * composition root that is allowed to close that gap inline.
 */
function createRandomIdGenerator(randomSource: RandomSource): IdGenerator {
  return {
    next(prefix: string): string {
      const bytes = randomSource.bytes(8);
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${prefix}-${hex}`;
    },
  };
}

const EMPTY_RECONCILIATION = {
  probed: 0,
  resumable: 0,
  failed: 0,
  cancelled: 0,
  unknown: 0,
} as const;

const EMPTY_ARTIFACT_RECOVERY = {
  removedIncoming: [] as readonly string[],
  skippedIncoming: [] as readonly string[],
  unreferencedBlobs: [] as readonly string[],
} as const;

/**
 * Starts one daemon instance end-to-end. Resolves once the outcome is known
 * — either `"serving"` (the socket is bound, published, and the connection
 * handler is attached) or `"exited"` (the process never reached `serving`;
 * the caller should exit with `exitCode` and touch nothing else, since every
 * losing/refusing/failing path already left the filesystem exactly as it
 * found it).
 */
export async function startDaemon(deps: StartDaemonDeps): Promise<StartDaemonOutcome> {
  const { home, backend } = deps;
  const protocolVersion = deps.protocolVersion ?? 1;

  const clock = createSystemClock();
  const randomSource = createSystemRandomSource();
  const macProvider = createHmacSha256MacProvider();
  const traceSink = createStderrTraceSink();
  const ids = createRandomIdGenerator(randomSource);
  const secretStore = createFileSecretStore({ directory: home.paths.secretsDirectory });

  let reconcileResult: ReconcileResult | undefined;
  let credential: DaemonCredential | undefined;

  const acquireDeps: AcquireDeps = {
    lockFileSystem: createNodeLockFileSystem(),
    socketBinder: createNodeSocketBinder(),
    socketProbe: createNodeSocketProbe(),
    processLiveness: createSystemProcessLiveness(),
    hostWitness: createSystemHostWitness(),
    randomSource,
    traceSink,
    clock,
    // design C1 steps 4-5: opens the owned DB, migrates, and reconciles
    // while still holding the claim — strictly before `acquireClaim` ever
    // calls `listen()`. The credential is minted and persisted here too, so
    // it is fresh before the bind on every path that reaches "acquired".
    recover: async (guard: LockHandle): Promise<void> => {
      const minted = mintCredential(randomSource);
      await persistCredential(secretStore, minted);
      credential = minted;

      reconcileResult = await reconcile(
        { lock: guard, backend },
        {
          database: { path: home.paths.stateDatabaseFile, clock, ids },
          artifactStore: { root: home.paths.artifactsDirectory, clock, ids },
        },
      );
    },
  };

  const acquireOptions: AcquireOptions = {
    runtimeDirectory: home.paths.runtimeDirectory,
    runtimeDirectoryParent: dirname(home.paths.runtimeDirectory),
    daemonPidFile: home.paths.daemonPidFile,
    daemonSocketFile: home.paths.daemonSocketFile,
    ownPid: process.pid,
  };

  let outcome: Awaited<ReturnType<typeof acquireClaim>>;
  try {
    outcome = await acquireClaim(acquireDeps, acquireOptions);
  } catch (error) {
    // `RecoveryFailedError` (the `recover` hook's own fatal path, which
    // already released the claim) or a `ClaimLostError` from a mid-pass
    // `assertStillHeld()` (which must not — a successor already holds the
    // claim) alike: neither is representable in `AcquireOutcome`'s `0/10/11`
    // discriminated union, and both mean the daemon never reached `serving`.
    // Design's exit-code contract groups both under `12`.
    return {
      kind: "exited",
      exitCode: 12,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  if (outcome.kind !== "acquired") {
    return { kind: "exited", exitCode: outcome.error.exitCode, error: outcome.error };
  }
  if (credential === undefined) {
    // Unreachable in practice — `recover` always runs, and always mints,
    // before `acquireClaim` can return "acquired" — kept as a typed guard
    // rather than a non-null assertion.
    outcome.handle.release();
    await outcome.socket.close();
    const error = new Error("acquireClaim reported 'acquired' without a minted credential");
    return { kind: "exited", exitCode: 12, error };
  }

  const { handle: guard, socket, instanceId } = outcome;
  let workspaceDatabase: ReturnType<typeof openStateDatabase>;
  try {
    workspaceDatabase = openStateDatabase({ path: home.paths.stateDatabaseFile, clock, ids });
    runMigrations(workspaceDatabase);
  } catch (error) {
    guard.release();
    await socket.close();
    await removeCredential(secretStore);
    return {
      kind: "exited",
      exitCode: 12,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  const workspaceService = createWorkspaceService({
    state: createWorkspaceStateStore(workspaceDatabase),
    workspacesDirectory: home.paths.workspacesDirectory,
    logsDirectory: home.paths.logsDirectory,
    clock,
    ids,
    liveness: createNodeOwnerLiveness(),
  });
  const startedAt = clock.nowIso();
  const reconciliation = reconcileResult?.reconciliation ?? EMPTY_RECONCILIATION;
  const artifactRecovery = reconcileResult?.artifactRecovery ?? EMPTY_ARTIFACT_RECOVERY;
  const classifications = reconcileResult?.classifications ?? [];

  // Resumes the same instance's trace at `serving` — `acquireClaim`'s own
  // internal tracer already reached exactly that state (see `trace.ts`'s
  // docblock for why this is a second, independent tracer rather than a
  // handle threaded across the module boundary).
  const servingTracer = createLifecycleTracer({
    instanceId,
    sink: traceSink,
    clock,
    initialState: "serving",
  });

  let draining = false;
  let stoppedResolve: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stoppedResolve = resolve;
  });

  async function beginDrain(reason: string): Promise<void> {
    if (draining) {
      return;
    }
    draining = true;
    servingTracer.record("drain", reason);
    // See `StartDaemonDeps.onDraining`'s docblock — held open only when a
    // caller supplied the hook; a no-op `Promise.resolve()` otherwise, so
    // production behaviour is unchanged.
    await deps.onDraining?.();
    // `close()` stops accepting new connections and unlinks the socket path
    // this process created (STD-3) — safe here, unlike on claim loss, since
    // this process still legitimately owns both.
    await socket.close();
    workspaceDatabase.close();
    // Inode-verified: only unlinks if the path still carries this guard's
    // identity.
    guard.release();
    await removeCredential(secretStore);
    servingTracer.record("stop", "graceful shutdown complete");
    stoppedResolve();
  }

  function requestDrain(): void {
    void beginDrain("drain requested");
  }

  const uninstallSignalHandlers = installSignalHandlers({
    onDrainRequested: (signal) => {
      void beginDrain(`received ${signal}`);
    },
    onForceExit: () => {
      // A second SIGTERM/SIGINT while already draining escalates to an
      // immediate exit (design C9) — no further cleanup attempted.
      process.exit(1);
    },
  });

  // On claim loss while serving: stop accepting new authenticated work
  // (the same `draining` flag `dispatch.ts` already checks), fail in-flight
  // requests with `-32000`, exit non-zero, and do NOT unlink the socket or
  // claim file — they belong to someone else now (design C9).
  guard.onLost((error) => {
    draining = true;
    servingTracer.record("lost", `claim lost while serving: ${error.message}`);
    uninstallSignalHandlers();
    process.exitCode = 1;
    process.exit(1);
  });

  const statusHandler = () => ({
    schemaVersion: 1,
    instanceId,
    lifecycleState: servingTracer.currentState(),
    startedAt,
    reconciliation,
    artifactRecovery: {
      removedIncoming: artifactRecovery.removedIncoming.length,
      skippedIncoming: artifactRecovery.skippedIncoming.length,
      unreferencedBlobs: artifactRecovery.unreferencedBlobs.length,
    },
  });
  const recoveryHandler = () => ({ schemaVersion: 1, classifications });
  const codebaseFileSystem = createCodebaseFileSystem();
  const codebaseGit = createNodeGitPort();
  const codebaseHash = createNodeHashPort();
  const codebaseDeps = {
    fs: codebaseFileSystem,
    git: codebaseGit,
    hash: codebaseHash,
    clock,
  };
  const codebaseParams = (params: unknown) => {
    if (
      typeof params !== "object" ||
      params === null ||
      !Array.isArray(Reflect.get(params, "roots"))
    ) {
      throw new Error("invalid codebase params");
    }
    const roots = Reflect.get(params, "roots");
    if (!roots.every((root: unknown) => typeof root === "string" && root.length > 0)) {
      throw new Error("invalid codebase roots");
    }
    const source = Reflect.get(params, "sourceRepositoryPath");
    return {
      roots: roots as string[],
      sourceRepositoryPath: typeof source === "string" ? source : null,
    };
  };
  const detectHandler = async (params: unknown) => {
    const input = codebaseParams(params);
    const registrations = await loadRegistrations({
      fs: codebaseFileSystem,
      hash: codebaseHash,
      codebasesDirectory: home.paths.codebasesDirectory,
    });
    return detectCodebase({ ...codebaseDeps, registrations }, input);
  };
  const registerHandler = async (params: unknown) => {
    const input = codebaseParams(params);
    const expectedTopologySha256 =
      typeof params === "object" && params !== null
        ? Reflect.get(params, "expectedTopologySha256")
        : undefined;
    const confirmed =
      typeof params === "object" && params !== null ? Reflect.get(params, "confirmed") : undefined;
    if (typeof expectedTopologySha256 !== "string" || confirmed !== true) {
      throw new Error("invalid registration confirmation");
    }
    const database = openStateDatabase({ path: home.paths.stateDatabaseFile, clock, ids });
    try {
      runMigrations(database);
      return await registerCodebase(
        {
          ...codebaseDeps,
          codebasesDirectory: home.paths.codebasesDirectory,
          ids,
          state: createRegistrationStatePort(database),
        },
        { ...input, expectedTopologySha256, confirmed: true },
      );
    } finally {
      database.close();
    }
  };
  const registry: MethodRegistry = createMethodRegistry([
    [DAEMON_STATUS_METHOD, statusHandler],
    [DAEMON_STATUS_V1_METHOD, statusHandler],
    [DAEMON_RECOVERY_METHOD, recoveryHandler],
    [DAEMON_RECOVERY_V1_METHOD, recoveryHandler],
    [CODEBASE_DETECT_V1_METHOD, detectHandler],
    [CODEBASE_REGISTER_V1_METHOD, registerHandler],
  ]);

  // Attached last (design's non-negotiable ordering) — no client can
  // complete a request against this daemon before every step above it has
  // already run.
  attachDaemonRpcServer(socket, {
    randomSource,
    macProvider,
    credential,
    registry,
    instanceId,
    protocolVersion,
    isDraining: () => draining,
    guard,
  });

  return { kind: "serving", instanceId, workspaceService, stopped, requestDrain };
}
