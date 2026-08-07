export {
  canonicaliseRequest,
  extractAuthValueText,
  hasDuplicateKey,
} from "./auth/canonical.js";
export type { ConnectionAuthState } from "./auth/challenge.js";
export { CHALLENGE_BYTES, mintConnectionAuthState } from "./auth/challenge.js";
export type { DaemonCredential } from "./auth/credential.js";
export {
  CREDENTIAL_ENTRY_NAME,
  CREDENTIAL_KEY_ID_BYTES,
  CREDENTIAL_SECRET_BYTES,
  mintCredential,
  persistCredential,
  removeCredential,
} from "./auth/credential.js";
export { UNAUTHORIZED_MESSAGE } from "./auth/errors.js";
export type { AuthenticatedCredential, VerifyResult } from "./auth/verify.js";
export { buildAuthMacMessage, bytesToHex, hexToBytes, verifyRequest } from "./auth/verify.js";
export type { AcquireDeps, AcquireOptions, AcquireOutcome } from "./lifecycle/acquire.js";
export { acquireClaim } from "./lifecycle/acquire.js";
export type { ClaimRecord, ClaimState, ParsedClaimRecord } from "./lifecycle/claim-record.js";
export {
  MAX_CLAIM_RECORD_BYTES,
  parseClaimRecord,
  serialiseClaimRecord,
} from "./lifecycle/claim-record.js";
export type { DaemonLifecycleExitCode } from "./lifecycle/errors.js";
export {
  AlreadyRunning,
  BindRaced,
  ClaimContended,
  ClaimInProgress,
  ClaimLostError,
  DaemonLifecycleError,
  ForeignSocketOccupied,
  InsecureClaimFile,
  InsecureRuntimeDirectory,
  InsecureSocketPath,
  PidFileNamesLiveProcess,
} from "./lifecycle/errors.js";
export type { ClaimGuardOptions, ClaimIdentity, LockHandle } from "./lifecycle/guard.js";
export { createClaimGuard } from "./lifecycle/guard.js";
export type { ProbeAttemptOutcome } from "./lifecycle/probe.js";
export { classifyProbeOutcome } from "./lifecycle/probe.js";
export type {
  BoundSocket,
  ClaimFileHandle,
  Clock,
  FileStat,
  HostWitness,
  IdGenerator,
  LifecycleTraceEvent,
  LifecycleTraceSink,
  LockFileSystem,
  MacProvider,
  ProcessLiveness,
  RandomSource,
  SocketBinder,
  SocketProbe,
  SocketProbeVerdict,
} from "./ports.js";
export type {
  DecodeResult,
  DecoderState,
  Frame,
  JsonRpcErrorFrame,
  JsonRpcId,
  JsonRpcRequestFrame,
} from "./rpc/codec.js";
export {
  createCodec,
  createDecoderState,
  decodeChunk,
  ERROR_CODES,
  encodeError,
  encodeResult,
  JSON_RPC_VERSION,
  MAX_LINE_BYTES,
} from "./rpc/codec.js";
export type { DispatchDeps } from "./rpc/dispatch.js";
export { dispatchFrame } from "./rpc/dispatch.js";
export { DRAINING_MESSAGE } from "./rpc/errors.js";
export type { MethodContext, MethodHandler, MethodRegistry } from "./rpc/methods.js";
export {
  AUTHENTICATED_METHODS,
  CODEBASE_DETECT_V1_METHOD,
  CODEBASE_REGISTER_V1_METHOD,
  createMethodRegistry,
  DAEMON_HELLO_METHOD,
  DAEMON_NEGOTIATE_METHOD,
  DAEMON_RECOVERY_METHOD,
  DAEMON_RECOVERY_V1_METHOD,
  DAEMON_STATUS_METHOD,
  DAEMON_STATUS_V1_METHOD,
  RPC_CANCEL_METHOD,
} from "./rpc/methods.js";
export { createSystemClock } from "./runtime/clock.js";
export type { ConnectionHandlerDeps } from "./runtime/compose.js";
export { attachDaemonRpcServer, createConnectionHandler } from "./runtime/compose.js";
export { createSystemHostWitness } from "./runtime/host-witness.js";
export { createNodeLockFileSystem } from "./runtime/lock-filesystem.js";
export { createHmacSha256MacProvider } from "./runtime/mac.js";
export { createSystemProcessLiveness } from "./runtime/process-liveness.js";
export { createSystemRandomSource } from "./runtime/random-source.js";
export type { SignalHandlerDeps } from "./runtime/signals.js";
export { installSignalHandlers } from "./runtime/signals.js";
export { createNodeSocketProbe } from "./runtime/socket-probe.js";
export type { RawConnection, SocketServerOptions } from "./runtime/socket-server.js";
export {
  createNodeSocketBinder,
  MAX_CONCURRENT_CONNECTIONS,
  MAX_UNAUTHENTICATED_CONNECTIONS,
} from "./runtime/socket-server.js";
export { createStderrTraceSink } from "./runtime/trace-sink.js";
