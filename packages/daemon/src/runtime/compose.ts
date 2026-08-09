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

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type CapabilityDiscoverySource,
  type ConfiguredCapabilityAccount,
  createCapabilityService,
  createStateCapabilitySnapshotStore,
} from "@heniek/capability";
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
import {
  type ArtifactId,
  type DoctorReportV1,
  type ExecutionBackend,
  type ExecutionBackendV7,
  ExecutionFailureV1,
  ExternalStageResultV1,
  InteractionAnswerSetV1,
  NativeStagePollRequestV1,
  NativeStageQuestionRequestV1,
  NativeStageSubmitRequestV1,
  ParentSessionAttachRequestV1,
  ParentSessionDetachRequestV1,
  PendingInteractionV2,
  type ResolvedProfileChainV1,
  RunAnswerRequestV2,
  RunResumeRequestV2,
  StageStartRequestV2,
} from "@heniek/contracts";
import { createFileSecretStore, createScopedSecretReader } from "@heniek/secrets";
import {
  findRegisteredExecutionContext,
  legacyAnswerSubmission,
  listInteractionInbox,
  listNativeQuestionInbox,
  openStateDatabase,
  readNativeStageAttempts,
  readParentSession,
  readPendingInteractions,
  readRunInteractions,
  readRunProjection,
  readStageArtifacts,
  runMigrations,
} from "@heniek/state";
import {
  createNodeOwnerLiveness,
  createWorkspaceService,
  createWorkspaceStateStore,
  type WorkspaceService,
} from "@heniek/workspace";
import { FormatRegistry, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { mintConnectionAuthState } from "../auth/challenge.js";
import {
  type DaemonCredential,
  mintCredential,
  persistCredential,
  removeCredential,
} from "../auth/credential.js";
import type { AuthenticatedCredential } from "../auth/verify.js";
import { appendCapabilityDoctorChecks } from "../capability/doctor.js";
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
  ARTIFACT_GET_V1_METHOD,
  CODEBASE_DETECT_V1_METHOD,
  CODEBASE_REGISTER_V1_METHOD,
  createMethodRegistry,
  DAEMON_RECOVERY_METHOD,
  DAEMON_RECOVERY_V1_METHOD,
  DAEMON_STATUS_METHOD,
  DAEMON_STATUS_V1_METHOD,
  DOCTOR_V1_METHOD,
  ENGINE_CATALOGUE_V1_METHOD,
  INBOX_LIST_V1_METHOD,
  type MethodHandler,
  type MethodRegistry,
  NATIVE_STAGE_POLL_V1_METHOD,
  NATIVE_STAGE_QUESTION_V1_METHOD,
  NATIVE_STAGE_STATUS_V1_METHOD,
  NATIVE_STAGE_SUBMIT_V1_METHOD,
  PARENT_SESSION_ATTACH_V1_METHOD,
  PARENT_SESSION_DETACH_V1_METHOD,
  RUN_ANSWER_V1_METHOD,
  RUN_ANSWER_V2_METHOD,
  RUN_CANCEL_V1_METHOD,
  RUN_RESULT_V1_METHOD,
  RUN_RESULT_V2_METHOD,
  RUN_RESULT_V3_METHOD,
  RUN_RESUME_V1_METHOD,
  RUN_RESUME_V2_METHOD,
  RUN_STATUS_V1_METHOD,
  RUN_STATUS_V2_METHOD,
  RUN_STATUS_V3_METHOD,
  RUN_STATUS_V4_METHOD,
  STAGE_START_V1_METHOD,
  STAGE_START_V2_METHOD,
  STAGE_START_V3_METHOD,
} from "../rpc/methods.js";
import { createSystemClock } from "./clock.js";
import {
  artifactResult,
  createExecutionService,
  type DurableExecutionBackend,
  type ExecutionService,
  stageRunResult,
} from "./execution-service.js";
import { createSystemHostWitness } from "./host-witness.js";
import { createNodeLockFileSystem } from "./lock-filesystem.js";
import { createHmacSha256MacProvider } from "./mac.js";
import { createNativeBridgeService, type NativeBridgeService } from "./native-bridge-service.js";
import { createSystemProcessLiveness } from "./process-liveness.js";
import { createSystemRandomSource } from "./random-source.js";
import { createSchedulingExecutionService } from "./scheduling-service.js";
import { installSignalHandlers } from "./signals.js";
import { createNodeSocketProbe } from "./socket-probe.js";
import type { RawConnection } from "./socket-server.js";
import { createNodeSocketBinder } from "./socket-server.js";
import { createStderrTraceSink } from "./trace-sink.js";

/**
 * TypeBox's `Value.Check` does not validate `format: "date-time"` unless a
 * checker is registered — unlike the Ajv instance `generate.ts` uses for
 * contract-schema codegen, which ships `date-time` support out of the box.
 * Q023's `nativeStage.question.v1`/`nativeStage.submit.v1` are the first
 * `Value.Check`'d request schemas in this file to carry a date-time field
 * (`PendingInteractionV2.requestedAt`); every well-formed request would
 * otherwise be rejected as malformed. `Date.parse` matches the same
 * leniency `native-bridge/store.ts`'s own `assertIso` already uses.
 */
FormatRegistry.Set("date-time", (value) => !Number.isNaN(Date.parse(value)));

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
  /** Q012 stage backend; omitted for legacy daemon/recovery consumers. */
  readonly backendV2?: DurableExecutionBackend;
  /** Q021 scheduler backend and already capability-checked flat profile-chain resolver. */
  readonly scheduling?: {
    readonly backend: ExecutionBackendV7;
    readonly resolveProfileChain: (
      profileId: string,
    ) => Promise<Static<typeof ResolvedProfileChainV1>> | Static<typeof ResolvedProfileChainV1>;
  };
  /**
   * Q023 native Claude bridge. A dedicated resolver rather than reusing
   * `scheduling.resolveProfileChain` (D1): a native profile has no account
   * to capacity-check, so its resolution is a different, simpler operation
   * than the scheduler's — sharing one function would force one of the two
   * modes to tolerate the other's constraints.
   */
  readonly nativeBridge?: {
    readonly resolveProfileChain: (
      profileId: string,
    ) => Promise<Static<typeof ResolvedProfileChainV1>> | Static<typeof ResolvedProfileChainV1>;
  };
  /** Provider-neutral catalogue source. Raw Claudexor DTOs stay inside its adapter. */
  readonly capability?: {
    readonly source: CapabilityDiscoverySource;
    readonly accounts: readonly ConfiguredCapabilityAccount[];
  };
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
      readonly executionService?: ExecutionService;
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

/** Matches `NativeStagePollRequestV1.maxDispatches`'s own `maximum: 16` — the advisory cap this daemon actually honours. */
const NATIVE_MAX_DISPATCHES = 16;
/** Advisory backoff hint echoed on every `nativeStage.poll.v1` response, accepted or rejected alike — not the background reap-sweep interval, which `NativeBridgeServiceOptions.pollMilliseconds` controls separately. */
const NATIVE_STAGE_POLL_AFTER_MS = 3_000;

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
        {
          lock: guard,
          backend,
          ...(deps.backendV2 === undefined ? {} : { backendV2: deps.backendV2 }),
        },
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
  const executionService =
    deps.backendV2 === undefined
      ? undefined
      : createExecutionService({
          db: workspaceDatabase,
          backend: deps.backendV2,
          workspaceService,
          artifactsDirectory: home.paths.artifactsDirectory,
          instanceId,
          ids,
        });
  const schedulingService =
    deps.scheduling === undefined
      ? undefined
      : createSchedulingExecutionService({
          db: workspaceDatabase,
          backend: deps.scheduling.backend,
          workspaceService,
          artifactsDirectory: home.paths.artifactsDirectory,
          instanceId,
          ids,
          clock,
          resolveProfileChain: deps.scheduling.resolveProfileChain,
          createIdentifierReader: (identifiers) =>
            createScopedSecretReader(secretStore, identifiers),
        });
  const nativeBridgeService: NativeBridgeService | undefined =
    deps.nativeBridge === undefined
      ? undefined
      : createNativeBridgeService({
          db: workspaceDatabase,
          workspaceService,
          artifactsDirectory: home.paths.artifactsDirectory,
          instanceId,
          ids,
          clock,
          resolveProfileChain: deps.nativeBridge.resolveProfileChain,
        });
  const capabilityService =
    deps.capability === undefined
      ? undefined
      : createCapabilityService({
          accounts: deps.capability.accounts,
          source: deps.capability.source,
          store: createStateCapabilitySnapshotStore(workspaceDatabase),
          clock: { now: () => new Date(clock.nowIso()) },
        });
  await executionService?.observeAll();
  await schedulingService?.reconcile();
  nativeBridgeService?.reconcile();
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
    executionService?.stop();
    schedulingService?.stop();
    nativeBridgeService?.stop();
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
  const recordParams = (params: unknown): Record<string, unknown> => {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new Error("invalid params");
    }
    return params as Record<string, unknown>;
  };
  const requiredParam = (params: Record<string, unknown>, name: string): string => {
    const value = params[name];
    if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${name}`);
    return value;
  };
  const withoutAuth = (params: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(params).filter(([key]) => key !== "auth"));
  const doctorHandler = async () => {
    const base: Static<typeof DoctorReportV1> =
      executionService === undefined
        ? {
            schemaVersion: 1,
            health: "failed",
            checks: [
              {
                category: "runtime",
                status: "fail",
                code: "CLAUDEXOR_BACKEND_UNCONFIGURED",
                message: "No Claudexor execution backend is configured.",
                remediation: "Configure the pinned Claudexor runtime and restart the daemon.",
              },
              {
                category: "auth-route",
                status: "fail",
                code: "AUTH_ROUTE_UNAVAILABLE",
                message: "Subscription-route attestation cannot run without a backend.",
              },
              {
                category: "compatibility",
                status: "fail",
                code: "COMPATIBILITY_UNAVAILABLE",
                message: "Claudexor compatibility cannot be checked without a backend.",
              },
              {
                category: "cleanup",
                status: "warn",
                code: "CLEANUP_NOT_CHECKED",
                message: "Execution cleanup checks were not run.",
              },
            ],
          }
        : await executionService.doctor();
    if (capabilityService === undefined) return base;
    const catalogue = await capabilityService.catalogue().catch(() => undefined);
    if (catalogue === undefined) return base;
    return appendCapabilityDoctorChecks(base, catalogue);
  };
  const entries: Array<readonly [string, MethodHandler]> = [
    [DAEMON_STATUS_METHOD, statusHandler],
    [DAEMON_STATUS_V1_METHOD, statusHandler],
    [DAEMON_RECOVERY_METHOD, recoveryHandler],
    [DAEMON_RECOVERY_V1_METHOD, recoveryHandler],
    [CODEBASE_DETECT_V1_METHOD, detectHandler],
    [CODEBASE_REGISTER_V1_METHOD, registerHandler],
    [DOCTOR_V1_METHOD, doctorHandler],
  ];
  if (capabilityService !== undefined) {
    entries.push([
      ENGINE_CATALOGUE_V1_METHOD,
      async (params) => {
        const input = recordParams(params);
        if (input.schemaVersion !== 1 || typeof input.refresh !== "boolean") {
          throw new Error("invalid capability catalogue request");
        }
        return capabilityService.catalogue({ refresh: input.refresh });
      },
    ]);
  }
  if (schedulingService !== undefined) {
    const schedulingPayload = (runId: string) => {
      const snapshot = schedulingService.status(runId);
      if (snapshot === undefined) throw new Error("scheduled run does not exist");
      const attempts = snapshot.attempts.map((attempt) => ({
        schemaVersion: 1,
        attemptId: attempt.attemptId,
        runId: attempt.runId,
        stageId: attempt.stageId,
        candidateIndex: attempt.candidateIndex,
        profileId: attempt.profileId,
        ...(attempt.accountId === null ? {} : { accountId: attempt.accountId }),
        ...(attempt.workspaceId === null ? {} : { workspaceId: attempt.workspaceId }),
        status: attempt.status,
        ...(attempt.backendExecutionId === null
          ? {}
          : { backendExecutionId: attempt.backendExecutionId }),
        limits: attempt.limits,
        permissions: attempt.permissions,
        ...(attempt.failure === null ? {} : { failure: attempt.failure }),
        ...(attempt.startedAt === null ? {} : { startedAt: attempt.startedAt }),
        ...(attempt.finishedAt === null ? {} : { finishedAt: attempt.finishedAt }),
      }));
      const decisions = snapshot.decisions.map((decision) => ({
        schemaVersion: 1,
        decisionId: decision.decisionId,
        runId: decision.runId,
        stageId: decision.stageId,
        ...(decision.candidateIndex === null ? {} : { candidateIndex: decision.candidateIndex }),
        ...(decision.profileId === null ? {} : { profileId: decision.profileId }),
        ...(decision.accountId === null ? {} : { accountId: decision.accountId }),
        kind: decision.kind,
        reasonCode: decision.reasonCode,
        recordedAt: decision.recordedAt,
      }));
      const selectedAttempt = snapshot.attempts.find(
        (attempt) => attempt.candidateIndex === snapshot.schedule.currentCandidateIndex,
      );
      return {
        snapshot,
        attempts,
        decisions,
        scheduling: {
          revision: snapshot.schedule.revision,
          state: snapshot.schedule.state,
          requestedPriority: snapshot.schedule.requestedPriority,
          ...(snapshot.schedule.currentCandidateIndex === null
            ? {}
            : { selectedCandidateIndex: snapshot.schedule.currentCandidateIndex }),
          ...(selectedAttempt === undefined
            ? {}
            : {
                selectedProfileId: selectedAttempt.profileId,
                ...(selectedAttempt.accountId === null
                  ? {}
                  : { selectedAccountId: selectedAttempt.accountId }),
              }),
        },
      };
    };
    entries.push(
      [
        STAGE_START_V2_METHOD,
        async (params) => {
          const input = withoutAuth(recordParams(params));
          const priority = input.priority;
          const requestedIdentifiers = input.requestedIdentifiers;
          const limits = input.limits;
          if (
            typeof priority !== "number" ||
            !Number.isSafeInteger(priority) ||
            priority < 0 ||
            priority > 9 ||
            !Array.isArray(requestedIdentifiers) ||
            !requestedIdentifiers.every((value) => typeof value === "string") ||
            typeof limits !== "object" ||
            limits === null ||
            Array.isArray(limits)
          ) {
            throw new Error("invalid scheduled stage request");
          }
          const started = await schedulingService.start({
            currentDirectory: requiredParam(input, "currentDirectory"),
            prompt: requiredParam(input, "prompt"),
            artifactPath: requiredParam(input, "artifactPath"),
            profileId: requiredParam(input, "profileId"),
            priority,
            requestedIdentifiers,
            limits: limits as { maxDurationMs?: number; maxTurns?: number },
          });
          const current = schedulingService.status(started.runId);
          return {
            schemaVersion: 2,
            ...started,
            status: current?.status ?? "queued",
          };
        },
      ],
      [
        RUN_STATUS_V3_METHOD,
        async (params) => {
          const runId = requiredParam(recordParams(params), "runId");
          const payload = schedulingPayload(runId);
          const projection = readRunProjection(workspaceDatabase, runId);
          if (projection === undefined) throw new Error("run projection does not exist");
          return {
            schemaVersion: 3,
            runId,
            stageId: payload.snapshot.schedule.stageId,
            status: payload.snapshot.status,
            runRevision: projection.revision,
            interactions: [
              ...readRunInteractions(workspaceDatabase, runId),
              ...schedulingService.interactions(runId),
            ],
            scheduling: payload.scheduling,
            attempts: payload.attempts,
            decisions: payload.decisions,
          };
        },
      ],
      [
        RUN_STATUS_V4_METHOD,
        async (params) => {
          const runId = requiredParam(recordParams(params), "runId");
          const payload = schedulingPayload(runId);
          const projection = readRunProjection(workspaceDatabase, runId);
          if (projection === undefined) throw new Error("run projection does not exist");
          return {
            schemaVersion: 4,
            runId,
            stageId: payload.snapshot.schedule.stageId,
            status: payload.snapshot.status,
            runRevision: projection.revision,
            interactions: [
              ...readRunInteractions(workspaceDatabase, runId),
              ...schedulingService.interactions(runId),
            ],
            scheduling: payload.scheduling,
            attempts: payload.attempts,
            // `schedulingPayload`'s decisions are built once, shared with the
            // still-registered v3 endpoint, and stamped `SchedulingDecision/v1`
            // there — v4 references `SchedulingDecision/v2` instead (D8), so
            // the stamp is overridden here rather than forking the mapper.
            decisions: payload.decisions.map((decision) => ({ ...decision, schemaVersion: 2 })),
          };
        },
      ],
      [
        RUN_RESULT_V2_METHOD,
        async (params) => {
          const runId = requiredParam(recordParams(params), "runId");
          const payload = schedulingPayload(runId);
          const result = schedulingService.result(runId);
          return {
            schemaVersion: 2,
            runId,
            stageId: payload.snapshot.schedule.stageId,
            status: payload.snapshot.status,
            ...(result?.summary === undefined ? {} : { summary: result.summary }),
            ...(result?.sessionId === undefined ? {} : { sessionId: result.sessionId }),
            artifacts: readStageArtifacts(workspaceDatabase, runId).map((artifact) => ({
              name: artifact.name,
              artifactId: artifact.artifactId,
              mediaType: artifact.mediaType,
              byteLength: artifact.byteLength,
              sha256: artifact.contentHash,
            })),
            scheduling: payload.scheduling,
            attempts: payload.attempts,
            decisions: payload.decisions,
          };
        },
      ],
      [
        RUN_RESULT_V3_METHOD,
        async (params) => {
          const runId = requiredParam(recordParams(params), "runId");
          const payload = schedulingPayload(runId);
          const result = schedulingService.result(runId);
          return {
            schemaVersion: 3,
            runId,
            stageId: payload.snapshot.schedule.stageId,
            status: payload.snapshot.status,
            ...(result?.summary === undefined ? {} : { summary: result.summary }),
            ...(result?.sessionId === undefined ? {} : { sessionId: result.sessionId }),
            artifacts: readStageArtifacts(workspaceDatabase, runId).map((artifact) => ({
              name: artifact.name,
              artifactId: artifact.artifactId,
              mediaType: artifact.mediaType,
              byteLength: artifact.byteLength,
              sha256: artifact.contentHash,
            })),
            scheduling: payload.scheduling,
            attempts: payload.attempts,
            decisions: payload.decisions.map((decision) => ({ ...decision, schemaVersion: 2 })),
          };
        },
      ],
      [
        RUN_CANCEL_V1_METHOD,
        async (params) => {
          const runId = requiredParam(recordParams(params), "runId");
          if (nativeBridgeService?.hasNativeStage(runId) === true) {
            const current = nativeBridgeService.cancel(runId);
            return {
              schemaVersion: 1,
              runId,
              status: current?.status ?? "cancelled",
              accepted: true,
            };
          }
          await schedulingService.cancel(runId);
          const current = schedulingService.status(runId);
          return {
            schemaVersion: 1,
            runId,
            status: current?.status ?? "cancelled",
            accepted: true,
          };
        },
      ],
      [
        RUN_ANSWER_V2_METHOD,
        async (params, context) => {
          const input = withoutAuth(recordParams(params));
          if (!Value.Check(RunAnswerRequestV2, input)) throw new Error("invalid answer request");
          if (context.authenticatedKeyId === undefined)
            throw new Error("authenticated key missing");
          if (nativeBridgeService?.hasNativeStage(input.runId) === true) {
            const accepted = nativeBridgeService.answer({
              runId: input.runId,
              submission: input.answer,
              answeredByKeyId: context.authenticatedKeyId,
            });
            return {
              schemaVersion: 2,
              runId: input.runId,
              status: accepted.status,
              runRevision: accepted.runRevision,
              interactionId: input.answer.interactionId,
              interactionRevision: accepted.interactionRevision,
              accepted: true,
              operationId: ids.next("operation"),
              deliveryState: "delivered",
            };
          }
          const accepted = await schedulingService.answer(
            input.runId,
            input.answer,
            context.authenticatedKeyId,
          );
          const projection = readRunProjection(workspaceDatabase, input.runId);
          const current = schedulingService.status(input.runId);
          return {
            schemaVersion: 2,
            runId: input.runId,
            status: current?.status ?? "queued",
            runRevision: projection?.revision ?? 1,
            interactionId: accepted.interactionId,
            interactionRevision: accepted.interactionRevision,
            accepted: true,
            operationId: accepted.operationId,
            deliveryState: "delivered",
          };
        },
      ],
    );
  }
  if (schedulingService !== undefined || nativeBridgeService !== undefined) {
    entries.push([
      STAGE_START_V3_METHOD,
      async (params) => {
        const input = withoutAuth(recordParams(params));
        if (!Value.Check(StageStartRequestV2, input))
          throw new Error("invalid stage start request");
        const routingResolver =
          deps.nativeBridge?.resolveProfileChain ?? deps.scheduling?.resolveProfileChain;
        if (routingResolver === undefined) throw new Error("no execution routing is configured");
        const chain = await routingResolver(input.profileId);
        if (chain.primary.executionMode === "native") {
          if (nativeBridgeService === undefined)
            throw new Error("native execution is not configured");
          const started = await nativeBridgeService.start({
            currentDirectory: input.currentDirectory,
            prompt: input.prompt,
            artifactPath: input.artifactPath,
            profileId: input.profileId,
            requestedIdentifiers: input.requestedIdentifiers,
            limits: input.limits,
          });
          const stageRevision = nativeBridgeService.status(started.runId)?.stage.revision;
          return {
            schemaVersion: 3,
            runId: started.runId,
            stageId: started.stageId,
            status: started.status,
            executionMode: "native",
            ...(stageRevision === undefined ? {} : { stageRevision }),
          };
        }
        if (schedulingService === undefined)
          throw new Error("external execution is not configured");
        const started = await schedulingService.start({
          currentDirectory: input.currentDirectory,
          prompt: input.prompt,
          artifactPath: input.artifactPath,
          profileId: input.profileId,
          priority: input.priority,
          requestedIdentifiers: input.requestedIdentifiers,
          limits: input.limits,
        });
        const current = schedulingService.status(started.runId);
        return {
          schemaVersion: 3,
          runId: started.runId,
          stageId: started.stageId,
          status: current?.status ?? "queued",
          executionMode: chain.primary.executionMode,
          schedulingRevision: started.schedulingRevision,
        };
      },
    ]);
  }
  if (executionService !== undefined || nativeBridgeService !== undefined) {
    entries.push([
      INBOX_LIST_V1_METHOD,
      async () => ({
        schemaVersion: 1,
        items: [
          ...(executionService === undefined ? [] : listInteractionInbox(workspaceDatabase)),
          ...(nativeBridgeService === undefined ? [] : listNativeQuestionInbox(workspaceDatabase)),
        ],
      }),
    ]);
  }
  if (executionService !== undefined) {
    entries.push(
      [
        STAGE_START_V1_METHOD,
        async (params) => {
          const input = recordParams(params);
          const limitsValue = input.limits;
          const limits =
            typeof limitsValue === "object" && limitsValue !== null && !Array.isArray(limitsValue)
              ? (limitsValue as { maxDurationMs?: number; maxTurns?: number })
              : undefined;
          const started = await executionService.start({
            currentDirectory: requiredParam(input, "currentDirectory"),
            prompt: requiredParam(input, "prompt"),
            artifactPath: requiredParam(input, "artifactPath"),
            ...(limits === undefined ? {} : { limits }),
          });
          return { schemaVersion: 1, ...started, status: "running" };
        },
      ],
      [
        RUN_STATUS_V1_METHOD,
        async (params) => {
          const row = await executionService.status(requiredParam(recordParams(params), "runId"));
          return {
            schemaVersion: 1,
            runId: row.runId,
            stageId: row.stageId,
            status: row.status,
            interactions: readPendingInteractions(workspaceDatabase, row.runId),
          };
        },
      ],
      [
        RUN_STATUS_V2_METHOD,
        async (params) => {
          const row = await executionService.status(requiredParam(recordParams(params), "runId"));
          const projection = readRunProjection(workspaceDatabase, row.runId);
          if (projection === undefined) throw new Error("run projection does not exist");
          return {
            schemaVersion: 2,
            runId: row.runId,
            stageId: row.stageId,
            status: row.status,
            runRevision: projection.revision,
            interactions: readRunInteractions(workspaceDatabase, row.runId),
          };
        },
      ],
      [
        RUN_ANSWER_V1_METHOD,
        async (params, context) => {
          const input = recordParams(params);
          const runId = requiredParam(input, "runId");
          const answer = input.answer;
          if (!Value.Check(InteractionAnswerSetV1, answer)) {
            throw new Error("invalid answer");
          }
          if (context.authenticatedKeyId === undefined)
            throw new Error("authenticated key missing");
          await executionService.answer(
            runId,
            legacyAnswerSubmission(workspaceDatabase, runId, answer),
            context.authenticatedKeyId,
          );
          const row = await executionService.status(runId);
          return { schemaVersion: 1, runId, status: row.status, accepted: true };
        },
      ],
      [
        RUN_ANSWER_V2_METHOD,
        async (params, context) => {
          const input = withoutAuth(recordParams(params));
          if (!Value.Check(RunAnswerRequestV2, input)) throw new Error("invalid answer request");
          if (context.authenticatedKeyId === undefined)
            throw new Error("authenticated key missing");
          if (nativeBridgeService?.hasNativeStage(input.runId) === true) {
            const accepted = nativeBridgeService.answer({
              runId: input.runId,
              submission: input.answer,
              answeredByKeyId: context.authenticatedKeyId,
            });
            return {
              schemaVersion: 2,
              runId: input.runId,
              status: accepted.status,
              runRevision: accepted.runRevision,
              interactionId: input.answer.interactionId,
              interactionRevision: accepted.interactionRevision,
              accepted: true,
              operationId: ids.next("operation"),
              deliveryState: "delivered",
            };
          }
          if (schedulingService?.status(input.runId) !== undefined) {
            const accepted = await schedulingService.answer(
              input.runId,
              input.answer,
              context.authenticatedKeyId,
            );
            const projection = readRunProjection(workspaceDatabase, input.runId);
            const current = schedulingService.status(input.runId);
            return {
              schemaVersion: 2,
              runId: input.runId,
              status: current?.status ?? "queued",
              runRevision: projection?.revision ?? 1,
              interactionId: accepted.interactionId,
              interactionRevision: accepted.interactionRevision,
              accepted: true,
              operationId: accepted.operationId,
              deliveryState: "delivered",
            };
          }
          const accepted = await executionService.answer(
            input.runId,
            input.answer,
            context.authenticatedKeyId,
          );
          return {
            schemaVersion: 2,
            runId: accepted.runId,
            status: accepted.status,
            runRevision: accepted.runRevision,
            interactionId: accepted.answer.interactionId,
            interactionRevision: accepted.interactionRevision,
            accepted: true,
            operationId: accepted.operationId,
            deliveryState: accepted.deliveryState,
          };
        },
      ],
      [
        RUN_RESUME_V1_METHOD,
        async (params) => {
          const input = recordParams(params);
          const runId = requiredParam(input, "runId");
          const refs = Array.isArray(input.inputArtifactRefs)
            ? input.inputArtifactRefs.filter(
                (value): value is ArtifactId => typeof value === "string",
              )
            : [];
          const projection = readRunProjection(workspaceDatabase, runId);
          if (projection === undefined) throw new Error("run projection does not exist");
          const resumed = await executionService.resume(runId, projection.revision, refs);
          return { schemaVersion: 1, runId, status: resumed.status, accepted: true };
        },
      ],
      [
        RUN_RESUME_V2_METHOD,
        async (params) => {
          const input = withoutAuth(recordParams(params));
          if (!Value.Check(RunResumeRequestV2, input)) throw new Error("invalid resume request");
          const resumed = await executionService.resume(
            input.runId,
            input.expectedRunRevision,
            input.inputArtifactRefs,
          );
          return {
            schemaVersion: 2,
            runId: resumed.runId,
            status: resumed.status,
            runRevision: resumed.runRevision,
            accepted: true,
            operationId: resumed.operationId,
            deliveryState: resumed.deliveryState,
          };
        },
      ],
      [
        RUN_CANCEL_V1_METHOD,
        async (params) => {
          const runId = requiredParam(recordParams(params), "runId");
          if (nativeBridgeService?.hasNativeStage(runId) === true) {
            const current = nativeBridgeService.cancel(runId);
            return {
              schemaVersion: 1,
              runId,
              status: current?.status ?? "cancelled",
              accepted: true,
            };
          }
          if (schedulingService?.status(runId) !== undefined) {
            await schedulingService.cancel(runId);
            const current = schedulingService.status(runId);
            return {
              schemaVersion: 1,
              runId,
              status: current?.status ?? "cancelled",
              accepted: true,
            };
          }
          await executionService.cancel(runId);
          const row = await executionService.status(runId);
          return { schemaVersion: 1, runId, status: row.status, accepted: true };
        },
      ],
      [
        RUN_RESULT_V1_METHOD,
        async (params) => {
          const row = await executionService.result(requiredParam(recordParams(params), "runId"));
          return stageRunResult(workspaceDatabase, row);
        },
      ],
    );
  }
  // Artifact retrieval reads the shared content-addressed store (D2/D7) —
  // every execution mode publishes through it, so this is registered
  // whenever any of them is configured, not only `executionService`.
  if (
    executionService !== undefined ||
    schedulingService !== undefined ||
    nativeBridgeService !== undefined
  ) {
    entries.push([
      ARTIFACT_GET_V1_METHOD,
      async (params) => {
        const input = recordParams(params);
        const artifactId = requiredParam(input, "artifactId");
        const artifact = artifactResult(workspaceDatabase, artifactId);
        if (artifact === undefined) throw new Error("artifact does not exist");
        const bytes = await readFile(join(home.paths.artifactsDirectory, artifact.relativePath));
        const requestedOffset = input.offset;
        const offset =
          requestedOffset === undefined
            ? 0
            : typeof requestedOffset === "number" &&
                Number.isSafeInteger(requestedOffset) &&
                requestedOffset >= 0
              ? requestedOffset
              : -1;
        if (offset < 0 || offset > bytes.byteLength) throw new Error("artifact offset is invalid");
        const chunk = bytes.subarray(offset, offset + 32 * 1024);
        return {
          schemaVersion: 1,
          artifactId: artifact.artifactId,
          name: artifact.name,
          mediaType: artifact.mediaType,
          byteLength: artifact.byteLength,
          sha256: artifact.contentHash,
          offset,
          eof: offset + chunk.byteLength === bytes.byteLength,
          contentBase64: chunk.toString("base64"),
        };
      },
    ]);
  }
  if (nativeBridgeService !== undefined) {
    const nativeBridge = nativeBridgeService;
    entries.push(
      [
        PARENT_SESSION_ATTACH_V1_METHOD,
        (params) => {
          const input = withoutAuth(recordParams(params));
          if (!Value.Check(ParentSessionAttachRequestV1, input))
            throw new Error("invalid parent session attach request");
          const context = findRegisteredExecutionContext(workspaceDatabase, input.currentDirectory);
          if (context === undefined) throw new Error("current directory is not registered");
          const outcome = nativeBridge.attach({
            codebaseId: context.codebaseId,
            ...(input.previousSessionId === undefined
              ? {}
              : { previousSessionId: input.previousSessionId }),
            ...(input.previousSessionRevision === undefined
              ? {}
              : { previousSessionRevision: input.previousSessionRevision }),
            resumeDispatchIds: input.resumeDispatchIds,
          });
          // `ParentSessionAttachmentV1` carries no `rejectionCode` field — a
          // rebind mismatch here is treated as a genuine caller error, unlike
          // poll/question/submit, which race against fencing as a matter of
          // course.
          if (!outcome.accepted) {
            throw new Error(`parent session attach rejected: ${outcome.rejectionCode}`);
          }
          return {
            schemaVersion: 1,
            sessionId: outcome.sessionId,
            sessionRevision: outcome.sessionRevision,
            codebaseId: context.codebaseId,
            attachedAt: outcome.attachedAt,
            expiresAt: outcome.expiresAt,
            leaseTtlMs: outcome.leaseTtlMs,
            maxDispatches: NATIVE_MAX_DISPATCHES,
            pollAfterMs: NATIVE_STAGE_POLL_AFTER_MS,
            resumedDispatchIds: outcome.resumedDispatchIds,
            ...(outcome.supersededSessionId === null
              ? {}
              : { supersededSessionId: outcome.supersededSessionId }),
          };
        },
      ],
      [
        PARENT_SESSION_DETACH_V1_METHOD,
        (params) => {
          const input = withoutAuth(recordParams(params));
          if (!Value.Check(ParentSessionDetachRequestV1, input))
            throw new Error("invalid parent session detach request");
          const outcome = nativeBridge.detach(input);
          return {
            schemaVersion: 1,
            accepted: outcome.accepted,
            ...(outcome.accepted ? {} : { rejectionCode: outcome.rejectionCode }),
            released: outcome.accepted ? outcome.released : [],
          };
        },
      ],
      [
        NATIVE_STAGE_POLL_V1_METHOD,
        async (params) => {
          const input = withoutAuth(recordParams(params));
          if (!Value.Check(NativeStagePollRequestV1, input))
            throw new Error("invalid native stage poll request");
          const maxDispatches = input.maxDispatches ?? NATIVE_MAX_DISPATCHES;
          // The wire request carries no `codebaseId` — the session already
          // pins one from `attach` — so it is resolved here rather than
          // trusted from the caller.
          const session = readParentSession(workspaceDatabase, input.sessionId);
          if (session === undefined) {
            return {
              schemaVersion: 1,
              accepted: false,
              rejectionCode: "session_not_attached",
              sessionRevision: input.sessionRevision,
              expiresAt: clock.nowIso(),
              pollAfterMs: NATIVE_STAGE_POLL_AFTER_MS,
              dispatches: [],
              resumes: [],
              revocations: [],
            };
          }
          const outcome = await nativeBridge.poll({
            sessionId: input.sessionId,
            sessionRevision: input.sessionRevision,
            codebaseId: session.codebaseId,
            maxDispatches,
          });
          if (!outcome.accepted) {
            // Re-read rather than reuse `session` — `poll()` runs the reap
            // sweep before this rejection can be produced, and may have
            // reclassified the session's liveness in the meantime.
            const current = readParentSession(workspaceDatabase, input.sessionId);
            return {
              schemaVersion: 1,
              accepted: false,
              rejectionCode: outcome.rejectionCode,
              sessionRevision: current?.revision ?? input.sessionRevision,
              expiresAt: current?.expiresAt ?? clock.nowIso(),
              pollAfterMs: NATIVE_STAGE_POLL_AFTER_MS,
              dispatches: [],
              resumes: [],
              revocations: [],
            };
          }
          const dispatches = outcome.claimed.flatMap((claim) => {
            const workingDirectory = outcome.workingDirectories.get(claim.dispatchId);
            // No entry means workspace provisioning failed after the claim
            // (`recordNativeAttemptWorkspaceFailure` already reverted the
            // stage to `waiting_for_parent`) — nothing to dispatch for it.
            if (workingDirectory === undefined) return [];
            const attempt = readNativeStageAttempts(workspaceDatabase, claim.runId).find(
              (candidate) => candidate.attemptId === claim.attemptId,
            );
            if (attempt?.workspaceId === undefined || attempt.workspaceId === null) return [];
            return [
              {
                schemaVersion: 1,
                dispatchId: claim.dispatchId,
                dispatchRevision: claim.dispatchRevision,
                runId: claim.runId,
                stageId: claim.stageId,
                attemptId: claim.attemptId,
                attemptOrdinal: claim.attemptOrdinal,
                workspaceId: attempt.workspaceId,
                workingDirectory,
                instructionsPath: claim.instructionsPath,
                prompt: claim.prompt,
                artifactPath: claim.artifactPath,
                artifactContract: claim.artifactContract,
                model: claim.model,
                effort: claim.effort,
                ...(claim.focus === null ? {} : { focus: claim.focus }),
                questions: claim.questions,
                permissions: JSON.parse(claim.permissionsJson),
                limits: JSON.parse(claim.limitsJson),
                issuedAt: claim.issuedAt,
                expiresAt: claim.expiresAt,
                ...(claim.hardDeadlineAt === null ? {} : { deadlineAt: claim.hardDeadlineAt }),
              },
            ];
          });
          return {
            schemaVersion: 1,
            accepted: true,
            sessionRevision: outcome.sessionRevision,
            expiresAt: outcome.expiresAt,
            pollAfterMs: NATIVE_STAGE_POLL_AFTER_MS,
            dispatches,
            resumes: outcome.resumes.map((resume) => ({
              dispatchId: resume.dispatchId,
              dispatchRevision: resume.dispatchRevision,
              interactionId: resume.interactionId,
              interactionRevision: resume.interactionRevision,
              answer: JSON.parse(resume.answerJson),
            })),
            revocations: outcome.revocations.map((revocation) => ({
              dispatchId: revocation.dispatchId,
              dispatchRevision: revocation.dispatchRevision,
              reason: revocation.terminalReason,
            })),
          };
        },
      ],
      [
        NATIVE_STAGE_QUESTION_V1_METHOD,
        (params) => {
          const input = withoutAuth(recordParams(params));
          // `NativeStageQuestionRequestV1.interaction` is a `Type.Ref` — Ajv's
          // in-schema `$ref` resolves against the manifest at generate time,
          // but TypeBox's own `Value.Check` needs the referenced schema
          // passed explicitly to dereference it at runtime.
          if (!Value.Check(NativeStageQuestionRequestV1, [PendingInteractionV2], input))
            throw new Error("invalid native stage question request");
          const outcome = nativeBridge.question({
            sessionId: input.sessionId,
            sessionRevision: input.sessionRevision,
            dispatchId: input.dispatchId,
            expectedDispatchRevision: input.expectedDispatchRevision,
            runId: input.runId,
            stageId: input.stageId,
            attemptId: input.attemptId,
            interaction: input.interaction as never,
          });
          if (!outcome.accepted) {
            return { schemaVersion: 1, accepted: false, rejectionCode: outcome.rejectionCode };
          }
          return {
            schemaVersion: 1,
            accepted: true,
            interactionId: outcome.interactionId,
            interactionRevision: outcome.interactionRevision,
            dispatchRevision: outcome.dispatchRevision,
            status: outcome.status,
          };
        },
      ],
      [
        NATIVE_STAGE_SUBMIT_V1_METHOD,
        async (params) => {
          const input = withoutAuth(recordParams(params));
          // `result`/`failure` are each a `Type.Ref` — see the question
          // handler's own comment on why the references must be explicit.
          if (
            !Value.Check(
              NativeStageSubmitRequestV1,
              [ExternalStageResultV1, ExecutionFailureV1],
              input,
            )
          )
            throw new Error("invalid native stage submit request");
          // The wire request carries no digest — computing it here from the
          // canonicalised payload, rather than trusting a client-supplied
          // value, is what makes it an honest mismatch detector (D4): a
          // retried submit with the same `submissionId` but different
          // content changes this digest, and only that.
          const submissionDigest = createHash("sha256")
            .update(
              JSON.stringify({
                outcome: input.outcome,
                result: input.result ?? null,
                failure: input.failure ?? null,
              }),
            )
            .digest("hex");
          const outcome = await nativeBridge.submit({
            sessionId: input.sessionId,
            sessionRevision: input.sessionRevision,
            dispatchId: input.dispatchId,
            expectedDispatchRevision: input.expectedDispatchRevision,
            runId: input.runId,
            stageId: input.stageId,
            attemptId: input.attemptId,
            submissionId: input.submissionId,
            submissionDigest,
            outcome: input.outcome,
            ...(input.result === undefined
              ? {}
              : {
                  declaredSummary: input.result.summary,
                  declaredArtifactPath: input.result.artifactPath,
                }),
            ...(input.failure === undefined ? {} : { failure: input.failure }),
          });
          const stageRevision = nativeBridge.status(input.runId)?.stage.revision ?? 1;
          if (!outcome.accepted) {
            const projection = readRunProjection(workspaceDatabase, input.runId);
            return {
              schemaVersion: 1,
              accepted: false,
              rejectionCode: outcome.rejectionCode,
              idempotentReplay: false,
              runId: input.runId,
              stageId: input.stageId,
              attemptId: input.attemptId,
              status: projection?.status ?? "failed",
              stageRevision,
            };
          }
          return {
            schemaVersion: 1,
            accepted: true,
            idempotentReplay: outcome.idempotentReplay,
            runId: input.runId,
            stageId: input.stageId,
            attemptId: input.attemptId,
            status: outcome.status,
            stageRevision,
          };
        },
      ],
      [
        NATIVE_STAGE_STATUS_V1_METHOD,
        (params) => {
          const runId = requiredParam(recordParams(params), "runId");
          const snapshot = nativeBridge.status(runId);
          if (snapshot === undefined) throw new Error("native stage does not exist");
          const projection = readRunProjection(workspaceDatabase, runId);
          if (projection === undefined) throw new Error("run projection does not exist");
          return {
            schemaVersion: 1,
            runId,
            stageId: snapshot.stage.stageId,
            status: projection.status,
            runRevision: snapshot.stage.runRevision,
            stageState: snapshot.stage.state,
            stageRevision: snapshot.stage.revision,
            attemptCount: snapshot.stage.attemptCount,
            ...(snapshot.stage.currentAttemptId === null
              ? {}
              : { currentAttemptId: snapshot.stage.currentAttemptId }),
            ...(snapshot.stage.waitingSince === null
              ? {}
              : { waitingSince: snapshot.stage.waitingSince }),
            attempts: snapshot.attempts.map((attempt) => ({
              schemaVersion: 1,
              attemptId: attempt.attemptId,
              runId: attempt.runId,
              stageId: attempt.stageId,
              attemptOrdinal: attempt.attemptOrdinal,
              ...(attempt.workspaceId === null ? {} : { workspaceId: attempt.workspaceId }),
              status: attempt.status,
              ...(attempt.failureJson === null ? {} : { failure: JSON.parse(attempt.failureJson) }),
              ...(attempt.startedAt === null ? {} : { startedAt: attempt.startedAt }),
              ...(attempt.finishedAt === null ? {} : { finishedAt: attempt.finishedAt }),
            })),
            interactions: snapshot.interactions.map((question) => question.canonical),
          };
        },
      ],
    );
  }
  // A daemon configured with only the native bridge (D1: it is a dedicated
  // service, not a scheduling/execution adapter) still needs `run.answer.v2`
  // and `run.cancel.v1` — otherwise a native-only deployment could raise a
  // question but never answer it, or never cancel a run. Both methods are
  // already registered above whenever `scheduling`/`executionService` is
  // configured (with a native-first branch); this is the fallback for the
  // one remaining case neither of those blocks runs at all.
  if (
    nativeBridgeService !== undefined &&
    schedulingService === undefined &&
    executionService === undefined
  ) {
    const nativeBridge = nativeBridgeService;
    entries.push(
      [
        RUN_ANSWER_V2_METHOD,
        async (params, context) => {
          const input = withoutAuth(recordParams(params));
          if (!Value.Check(RunAnswerRequestV2, input)) throw new Error("invalid answer request");
          if (context.authenticatedKeyId === undefined)
            throw new Error("authenticated key missing");
          const accepted = nativeBridge.answer({
            runId: input.runId,
            submission: input.answer,
            answeredByKeyId: context.authenticatedKeyId,
          });
          return {
            schemaVersion: 2,
            runId: input.runId,
            status: accepted.status,
            runRevision: accepted.runRevision,
            interactionId: input.answer.interactionId,
            interactionRevision: accepted.interactionRevision,
            accepted: true,
            operationId: ids.next("operation"),
            deliveryState: "delivered",
          };
        },
      ],
      [
        RUN_CANCEL_V1_METHOD,
        async (params) => {
          const runId = requiredParam(recordParams(params), "runId");
          const current = nativeBridge.cancel(runId);
          return {
            schemaVersion: 1,
            runId,
            status: current?.status ?? "cancelled",
            accepted: true,
          };
        },
      ],
    );
  }
  const registry: MethodRegistry = createMethodRegistry(entries);

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

  return {
    kind: "serving",
    instanceId,
    workspaceService,
    ...(executionService === undefined ? {} : { executionService }),
    stopped,
    requestDrain,
  };
}
