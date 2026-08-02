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
