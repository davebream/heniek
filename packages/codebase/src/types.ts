import type {
  CodebaseDetectionResultV1,
  InstructionDiagnosticV1,
  InstructionSnapshotV1,
  RegisteredCodebaseV1,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";

export type CodebaseDetectionResult = Static<typeof CodebaseDetectionResultV1>;
export type InstructionDiagnostic = Static<typeof InstructionDiagnosticV1>;
export type InstructionSnapshot = Static<typeof InstructionSnapshotV1>;
export type RegisteredCodebase = Static<typeof RegisteredCodebaseV1>;

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly directory: boolean;
}

export interface CodebaseFileSystem {
  realpath(path: string): Promise<string>;
  readText(path: string): Promise<string>;
  list(path: string): Promise<readonly FileEntry[]>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  writeTextAtomic(path: string, content: string): Promise<void>;
}

export interface HashPort {
  sha256(value: string | Uint8Array): string;
}

export interface ClockPort {
  nowIso(): string;
}

export interface IdPort {
  next(prefix: "cb" | "repo" | "proposal"): string;
}

export interface GitRemoteObservation {
  readonly name: string;
  readonly fetchUrl: string | null;
  readonly pushUrl: string | null;
  readonly defaultBranch: string | null;
}

export interface GitRepositoryObservation {
  readonly path: string;
  readonly gitCommonDirectory: string;
  readonly remotes: readonly GitRemoteObservation[];
  readonly defaultRemote: string | null;
  readonly defaultBranch: string | null;
  readonly visibleFiles: readonly string[];
}

export interface GitPort {
  inspect(path: string): Promise<GitRepositoryObservation | null>;
}

export interface AdditionalInstructionSource {
  readonly kind: "orchestrator" | "profile-role" | "stage";
  /** Absolute or process-resolvable path used only to read the source. */
  readonly path: string;
  /** Stable path relative to the application home, persisted in snapshots. */
  readonly locationPath: string;
  readonly scope?: string;
}
