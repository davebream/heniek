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
  encodeError,
  encodeResult,
  ERROR_CODES,
  JSON_RPC_VERSION,
  MAX_LINE_BYTES,
} from "./rpc/codec.js";
export type { DispatchDeps } from "./rpc/dispatch.js";
export { dispatchFrame } from "./rpc/dispatch.js";
export { DRAINING_MESSAGE } from "./rpc/errors.js";
export type { MethodHandler, MethodRegistry } from "./rpc/methods.js";
export {
  AUTHENTICATED_METHODS,
  createMethodRegistry,
  DAEMON_HELLO_METHOD,
  DAEMON_RECOVERY_METHOD,
  DAEMON_STATUS_METHOD,
} from "./rpc/methods.js";
