import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import fixture from "../../test/fixtures/q033-composite-config.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const JOURNAL_NAME = "q033-journal.json";
const SETUP_CONCURRENCY = 3;

const REPOSITORY_NAMES = [
  "contracts",
  "shared",
  "api",
  "worker",
  "web",
  "admin",
  "mobile",
  "docs",
  "infra",
  "e2e",
] as const;
type RepositoryName = (typeof REPOSITORY_NAMES)[number];
interface Q033RepositoryConfiguration {
  readonly name: RepositoryName;
  readonly dependencies: readonly RepositoryName[];
  readonly writable: boolean;
}

function parseFixtureConfiguration(): readonly Q033RepositoryConfiguration[] {
  const names = new Set<string>(REPOSITORY_NAMES);
  if (fixture.repositories.length !== 10)
    throw new Error("Q033 fixture must contain ten repositories.");
  const seen = new Set<string>();
  const parsed = fixture.repositories.map((repository) => {
    if (!names.has(repository.name) || seen.has(repository.name))
      throw new Error("Q033 fixture has an invalid or duplicate repository name.");
    if (repository.dependencies.some((dependency) => !names.has(dependency)))
      throw new Error("Q033 fixture has an unknown setup dependency.");
    seen.add(repository.name);
    return repository as Q033RepositoryConfiguration;
  });
  if (parsed.filter((repository) => repository.writable).length !== 3)
    throw new Error("Q033 fixture must declare exactly three writable repositories.");
  return parsed;
}

export const Q033_REPOSITORIES = parseFixtureConfiguration();
type RepositoryPhase =
  | "pending"
  | "registered"
  | "checkout-created"
  | "setup-completed"
  | "setup-failed"
  | "blocked"
  | "cancelled";
type FaultKind = "clone" | "setup" | "disk" | "cancel" | "crash";

export interface Q033Fault {
  readonly kind: FaultKind;
  readonly repository: RepositoryName;
}

interface RepositoryJournal {
  readonly name: RepositoryName;
  readonly remotePath: string;
  readonly registrationPath: string;
  readonly checkoutPath: string;
  readonly dependencies: readonly string[];
  readonly writable: boolean;
  baseSha: string;
  phase: RepositoryPhase;
  setupAttempts: number;
}

interface Q033Journal {
  readonly schemaVersion: 1;
  readonly workspaceId: "ws_q033";
  readonly intentSha256: string;
  readonly rootPath: string;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  updatedAt: string;
  repositories: RepositoryJournal[];
}

export interface Q033FailureRecord {
  readonly code: string;
  readonly phase: string;
  readonly repository: string;
  readonly recovered: boolean;
}

export interface Q033RepositoryResult {
  readonly name: string;
  readonly baseSha: string;
  readonly checkoutHeadSha: string | null;
  readonly phase: RepositoryPhase;
  readonly setupAttempts: number;
  readonly writable: boolean;
  readonly changed: boolean;
}

export interface Q033Report {
  readonly schemaVersion: "heniek.q033-composite-spike/v1";
  readonly scenario: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly gitVersion: string;
  readonly layout: "registered-clones-linked-worktrees";
  readonly workspaceRoot: "$SANDBOX/workspaces/ws_q033";
  readonly compositeRootIsGitRepository: false;
  readonly repositoryCount: 10;
  readonly semanticReadSet: readonly string[];
  readonly writeSet: readonly string[];
  readonly crossRepositoryVerification: boolean;
  readonly setupOrder: readonly string[];
  readonly repositories: readonly Q033RepositoryResult[];
  readonly failures: readonly Q033FailureRecord[];
  readonly metrics: {
    readonly elapsedMilliseconds: number;
    readonly peakChildProcesses: number;
    readonly remainingChildProcesses: number;
    readonly logicalBytesAtPeak: number;
    readonly allocatedBytesAtPeak: number;
    readonly logicalBytesAfterCleanup: number;
    readonly allocatedBytesAfterCleanup: number;
  };
  readonly cleanup: {
    readonly requested: boolean;
    readonly completed: boolean;
    readonly idempotent: boolean;
  };
}

export class Q033SpikeError extends Error {
  readonly code: string;
  readonly phase: string;
  readonly repository: string;

  constructor(code: string, phase: string, repository: string, message: string) {
    super(message);
    this.name = "Q033SpikeError";
    this.code = code;
    this.phase = phase;
    this.repository = repository;
  }
}

export interface Q033RunOptions {
  readonly rootPath?: string;
  readonly scenario?: string;
  readonly fault?: Q033Fault;
  readonly cleanup?: boolean;
}

interface DirectoryUsage {
  logicalBytes: number;
  allocatedBytes: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return result.stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/\s+/gu, " ") : "git failed";
    throw new Error(`git ${args[0] ?? "command"} failed: ${detail}`);
  }
}

async function directoryUsage(path: string): Promise<DirectoryUsage> {
  if (!(await exists(path))) return { logicalBytes: 0, allocatedBytes: 0 };
  const usage = { logicalBytes: 0, allocatedBytes: 0 };
  async function visit(current: string): Promise<void> {
    const currentStat = await lstat(current);
    usage.logicalBytes += currentStat.size;
    usage.allocatedBytes += (currentStat.blocks ?? 0) * 512;
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) return;
    const entries = await readdir(current);
    await Promise.all(entries.map((entry) => visit(join(current, entry))));
  }
  await visit(path);
  return usage;
}

function intentSha256(): string {
  return sha256(JSON.stringify(Q033_REPOSITORIES));
}

async function writeJournal(journal: Q033Journal): Promise<void> {
  journal.updatedAt = new Date().toISOString();
  const path = join(journal.workspaceRoot, JOURNAL_NAME);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(journal.workspaceRoot, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function validateJournal(value: unknown, expectedRoot: string): asserts value is Q033Journal {
  if (typeof value !== "object" || value === null)
    throw new Q033SpikeError(
      "JOURNAL_CORRUPT",
      "restart",
      "composite",
      "Journal is not an object.",
    );
  const candidate = value as Partial<Q033Journal>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.intentSha256 !== intentSha256() ||
    candidate.rootPath !== expectedRoot ||
    !Array.isArray(candidate.repositories) ||
    candidate.repositories.length !== Q033_REPOSITORIES.length
  ) {
    throw new Q033SpikeError(
      "RESTART_INTENT_MISMATCH",
      "restart",
      "composite",
      "Journal does not match the Q033 fixture intent.",
    );
  }
}

async function seedRepository(
  rootPath: string,
  name: RepositoryName,
  index: number,
): Promise<void> {
  const remotePath = join(rootPath, "remotes", `${name}.git`);
  if (await exists(remotePath)) return;
  const seedPath = join(rootPath, "seeds", name);
  await mkdir(seedPath, { recursive: true, mode: 0o700 });
  await git(rootPath, "init", "--bare", remotePath);
  await git(seedPath, "init", "-b", "main");
  await git(seedPath, "config", "user.name", "Heniek Q033");
  await git(seedPath, "config", "user.email", "q033@example.invalid");
  await writeFile(
    join(seedPath, "README.md"),
    `# ${name}\nsemantic-marker=${index}-${name}\n`,
    "utf8",
  );
  await writeFile(
    join(seedPath, "repository.json"),
    `${JSON.stringify({ name, index })}\n`,
    "utf8",
  );
  await git(seedPath, "add", "README.md", "repository.json");
  await git(seedPath, "commit", "-m", `seed ${name}`);
  await git(seedPath, "remote", "add", "origin", remotePath);
  await git(seedPath, "push", "-u", "origin", "main");
  await git(remotePath, "symbolic-ref", "HEAD", "refs/heads/main");
}

async function createOrLoadJournal(rootPath: string): Promise<Q033Journal> {
  const workspaceRoot = join(rootPath, "workspaces", "ws_q033");
  const journalPath = join(workspaceRoot, JOURNAL_NAME);
  if (await exists(journalPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(journalPath, "utf8"));
    } catch {
      throw new Q033SpikeError(
        "JOURNAL_CORRUPT",
        "restart",
        "composite",
        "Journal is not valid JSON.",
      );
    }
    validateJournal(parsed, rootPath);
    return parsed;
  }
  await Promise.all(
    Q033_REPOSITORIES.map((repository, index) => seedRepository(rootPath, repository.name, index)),
  );
  const journal: Q033Journal = {
    schemaVersion: 1,
    workspaceId: "ws_q033",
    intentSha256: intentSha256(),
    rootPath,
    workspaceRoot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    repositories: Q033_REPOSITORIES.map((repository) => ({
      ...repository,
      dependencies: [...repository.dependencies],
      remotePath: join(rootPath, "remotes", `${repository.name}.git`),
      registrationPath: join(rootPath, "registrations", repository.name),
      checkoutPath: join(workspaceRoot, "checkouts", repository.name),
      baseSha: "",
      phase: "pending",
      setupAttempts: 0,
    })),
  };
  for (const repository of journal.repositories) repository.baseSha = await resolveBase(repository);
  await writeJournal(journal);
  return journal;
}

async function resolveBase(repository: RepositoryJournal): Promise<string> {
  const output = await git(repository.remotePath, "rev-parse", "refs/heads/main");
  if (!/^[a-f0-9]{40}$/u.test(output))
    throw new Q033SpikeError(
      "BASE_INVALID",
      "base",
      repository.name,
      "Remote base is not a full commit SHA.",
    );
  return output;
}

async function ensureRegistration(repository: RepositoryJournal, fault?: Q033Fault): Promise<void> {
  if (await exists(join(repository.registrationPath, ".git"))) return;
  if (fault?.kind === "clone" && fault.repository === repository.name) {
    throw new Q033SpikeError("CLONE_FAILED", "clone", repository.name, "Injected clone failure.");
  }
  await mkdir(resolve(repository.registrationPath, ".."), { recursive: true, mode: 0o700 });
  await git(
    resolve(repository.registrationPath, ".."),
    "clone",
    "--quiet",
    repository.remotePath,
    repository.registrationPath,
  );
}

async function ensureCheckout(
  repository: RepositoryJournal,
  fault?: Q033Fault,
): Promise<"created" | "reconciled" | "existing"> {
  const gitFile = join(repository.checkoutPath, ".git");
  if (await exists(gitFile)) {
    const head = await git(repository.checkoutPath, "rev-parse", "HEAD");
    if (head !== repository.baseSha)
      throw new Q033SpikeError(
        "RESTART_HEAD_MISMATCH",
        "restart",
        repository.name,
        "Partial checkout no longer matches its base pin.",
      );
    return repository.phase === "registered" ? "reconciled" : "existing";
  }
  await mkdir(resolve(repository.checkoutPath, ".."), { recursive: true, mode: 0o700 });
  await git(
    repository.registrationPath,
    "worktree",
    "add",
    "--quiet",
    "-b",
    `q033/ws_q033/${repository.name}`,
    repository.checkoutPath,
    repository.baseSha,
  );
  if (fault?.kind === "disk" && fault.repository === repository.name) {
    throw new Q033SpikeError(
      "ENOSPC",
      "checkout-journal",
      repository.name,
      "Injected disk exhaustion after worktree creation.",
    );
  }
  if (fault?.kind === "crash" && fault.repository === repository.name) {
    throw new Q033SpikeError(
      "PROCESS_INTERRUPTED",
      "checkout-journal",
      repository.name,
      "Injected interruption after worktree creation.",
    );
  }
  return "created";
}

async function runSetupProcess(
  repository: RepositoryJournal,
  fault: Q033Fault | undefined,
  signal: AbortSignal,
  onStarted: () => void,
  onFinished: () => void,
): Promise<void> {
  const shouldFail = fault?.kind === "setup" && fault.repository === repository.name;
  const shouldCancel = fault?.kind === "cancel" && fault.repository === repository.name;
  const delay = shouldCancel ? 10_000 : 15 + repository.dependencies.length * 5;
  const program = shouldFail
    ? "process.stderr.write('token=fixture-secret\\n'); process.exit(17)"
    : `setTimeout(() => process.exit(0), ${delay})`;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["-e", program], {
      cwd: repository.checkoutPath,
      detached: true,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: "ignore",
    });
    onStarted();
    let settled = false;
    const terminate = () => {
      if (settled) return;
      try {
        if (child.pid === undefined) throw new Error("setup child has no pid");
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    signal.addEventListener("abort", terminate, { once: true });
    let cancelTimer: NodeJS.Timeout | undefined;
    if (shouldCancel) cancelTimer = setTimeout(terminate, 30);
    child.on("error", (error) => {
      settled = true;
      if (cancelTimer !== undefined) clearTimeout(cancelTimer);
      signal.removeEventListener("abort", terminate);
      onFinished();
      reject(error);
    });
    child.on("close", (code, closeSignal) => {
      settled = true;
      if (cancelTimer !== undefined) clearTimeout(cancelTimer);
      signal.removeEventListener("abort", terminate);
      onFinished();
      if (shouldCancel || signal.aborted || closeSignal !== null) {
        reject(new Q033SpikeError("CANCELLED", "setup", repository.name, "Setup was cancelled."));
      } else if (code !== 0) {
        reject(
          new Q033SpikeError(
            "SETUP_FAILED",
            "setup",
            repository.name,
            "Setup exited unsuccessfully; output was discarded.",
          ),
        );
      } else resolvePromise();
    });
  });
}

async function compositeRootIsGitRepository(workspaceRoot: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

async function cleanupFixture(journal: Q033Journal): Promise<boolean> {
  for (const repository of [...journal.repositories].reverse()) {
    if (await exists(repository.registrationPath)) {
      if (await exists(repository.checkoutPath)) {
        try {
          await git(
            repository.registrationPath,
            "worktree",
            "remove",
            "--force",
            repository.checkoutPath,
          );
        } catch {
          // The final bounded removal below handles an already-detached partial checkout.
        }
      }
      try {
        await git(repository.registrationPath, "worktree", "prune");
      } catch {
        // A failed registration may not be a repository.
      }
    }
  }
  const marker = basename(journal.rootPath);
  if (!marker.startsWith("heniek-q033-")) throw new Error("Refusing to clean a non-Q033 sandbox.");
  await rm(journal.rootPath, { recursive: true, force: true });
  await rm(journal.rootPath, { recursive: true, force: true });
  return !(await exists(journal.rootPath));
}

export async function createQ033Sandbox(): Promise<string> {
  return mkdtemp(join(tmpdir(), "heniek-q033-"));
}

export async function runQ033CompositeSpike(options: Q033RunOptions = {}): Promise<Q033Report> {
  const started = performance.now();
  const rootPath = options.rootPath ?? (await createQ033Sandbox());
  const cleanup = options.cleanup ?? true;
  const scenario = options.scenario ?? options.fault?.kind ?? "success";
  const journal = await createOrLoadJournal(rootPath);
  const failures: Q033FailureRecord[] = [];
  const setupOrder: string[] = [];
  let activeChildren = 0;
  let peakChildren = 0;

  for (const repository of journal.repositories) {
    if (repository.phase === "setup-completed") continue;
    try {
      const resolvedBase = await resolveBase(repository);
      if (repository.baseSha === "") repository.baseSha = resolvedBase;
      // A moved remote is observed but never replaces the durable base pin.
      await ensureRegistration(repository, options.fault);
      repository.phase = "registered";
      await writeJournal(journal);
      await ensureCheckout(repository, options.fault);
      repository.phase = "checkout-created";
      await writeJournal(journal);
    } catch (error) {
      if (!(error instanceof Q033SpikeError)) throw error;
      failures.push({
        code: error.code,
        phase: error.phase,
        repository: error.repository,
        recovered: false,
      });
      await writeJournal(journal);
      break;
    }
  }

  const abortController = new AbortController();
  if (failures.length === 0) {
    while (journal.repositories.some((repository) => repository.phase === "checkout-created")) {
      const ready = journal.repositories.filter(
        (repository) =>
          repository.phase === "checkout-created" &&
          repository.dependencies.every(
            (dependency) =>
              journal.repositories.find((candidate) => candidate.name === dependency)?.phase ===
              "setup-completed",
          ),
      );
      if (ready.length === 0) {
        for (const repository of journal.repositories) {
          if (repository.phase === "checkout-created") {
            repository.phase = abortController.signal.aborted ? "cancelled" : "blocked";
          }
        }
        await writeJournal(journal);
        break;
      }
      for (let offset = 0; offset < ready.length; offset += SETUP_CONCURRENCY) {
        const batch = ready.slice(offset, offset + SETUP_CONCURRENCY);
        await Promise.all(
          batch.map(async (repository) => {
            repository.setupAttempts += 1;
            setupOrder.push(repository.name);
            try {
              await runSetupProcess(
                repository,
                options.fault,
                abortController.signal,
                () => {
                  activeChildren += 1;
                  peakChildren = Math.max(peakChildren, activeChildren);
                },
                () => {
                  activeChildren -= 1;
                },
              );
              repository.phase = "setup-completed";
              await mkdir(join(journal.workspaceRoot, "setup"), { recursive: true, mode: 0o700 });
              await writeFile(
                join(journal.workspaceRoot, "setup", `${repository.name}.json`),
                `${JSON.stringify({ repository: repository.name, dependencies: repository.dependencies })}\n`,
                { mode: 0o600 },
              );
            } catch (error) {
              if (!(error instanceof Q033SpikeError)) throw error;
              repository.phase = error.code === "CANCELLED" ? "cancelled" : "setup-failed";
              failures.push({
                code: error.code,
                phase: error.phase,
                repository: error.repository,
                recovered: false,
              });
              if (error.code === "CANCELLED") abortController.abort();
            }
            await writeJournal(journal);
          }),
        );
      }
    }
  }

  for (const repository of journal.repositories) {
    if (repository.phase !== "checkout-created") continue;
    const dependencyFailed = repository.dependencies.some((dependency) => {
      const phase = journal.repositories.find((candidate) => candidate.name === dependency)?.phase;
      return phase === "setup-failed" || phase === "blocked" || phase === "cancelled";
    });
    if (dependencyFailed)
      repository.phase = abortController.signal.aborted ? "cancelled" : "blocked";
  }
  await writeJournal(journal);

  const allProvisioned = journal.repositories.every((repository) =>
    ["setup-completed", "setup-failed", "blocked", "cancelled"].includes(repository.phase),
  );
  const semanticReadSet: string[] = [];
  let crossRepositoryVerification = false;
  if (allProvisioned) {
    for (const repository of journal.repositories) {
      if (!(await exists(repository.checkoutPath))) continue;
      const metadata = JSON.parse(
        await readFile(join(repository.checkoutPath, "repository.json"), "utf8"),
      ) as { name: string };
      if (metadata.name !== repository.name)
        throw new Error("Semantic repository marker mismatch.");
      semanticReadSet.push(repository.name);
    }
  }

  if (failures.length === 0) {
    const verificationInputs = await Promise.all(
      journal.repositories.map(async (repository) => ({
        repository: JSON.parse(
          await readFile(join(repository.checkoutPath, "repository.json"), "utf8"),
        ) as { name?: string },
        setup: JSON.parse(
          await readFile(join(journal.workspaceRoot, "setup", `${repository.name}.json`), "utf8"),
        ) as { repository?: string },
      })),
    );
    crossRepositoryVerification = verificationInputs.every(
      (input, index) =>
        input.repository.name === journal.repositories[index]?.name &&
        input.setup.repository === journal.repositories[index]?.name,
    );
    if (!crossRepositoryVerification) throw new Error("Cross-repository verification failed.");
    for (const repository of journal.repositories.filter((candidate) => candidate.writable)) {
      await writeFile(
        join(repository.checkoutPath, "q033-change.txt"),
        `scoped write: ${repository.name}\n`,
        "utf8",
      );
    }
  }

  const rootIsGit = await compositeRootIsGitRepository(journal.workspaceRoot);
  if (rootIsGit) throw new Error("Composite root unexpectedly resolved as a Git repository.");
  const repositories: Q033RepositoryResult[] = [];
  for (const repository of journal.repositories) {
    const checkoutExists = await exists(repository.checkoutPath);
    const head = checkoutExists ? await git(repository.checkoutPath, "rev-parse", "HEAD") : null;
    const changed = checkoutExists
      ? (await git(repository.checkoutPath, "status", "--porcelain")) !== ""
      : false;
    if (failures.length === 0 && changed !== repository.writable)
      throw new Error(`Write scope mismatch for ${repository.name}.`);
    repositories.push({
      name: repository.name,
      baseSha: repository.baseSha,
      checkoutHeadSha: head,
      phase: repository.phase,
      setupAttempts: repository.setupAttempts,
      writable: repository.writable,
      changed,
    });
  }

  const peakUsage = await directoryUsage(rootPath);
  let cleanupCompleted = false;
  let cleanupIdempotent = false;
  if (cleanup) {
    cleanupCompleted = await cleanupFixture(journal);
    cleanupIdempotent = cleanupCompleted;
  }
  const afterCleanup = await directoryUsage(rootPath);
  const gitVersion = await execFileAsync("git", ["--version"], { encoding: "utf8" });
  return {
    schemaVersion: "heniek.q033-composite-spike/v1",
    scenario,
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    gitVersion: gitVersion.stdout.trim(),
    layout: "registered-clones-linked-worktrees",
    workspaceRoot: "$SANDBOX/workspaces/ws_q033",
    compositeRootIsGitRepository: false,
    repositoryCount: 10,
    semanticReadSet,
    writeSet: Q033_REPOSITORIES.filter((repository) => repository.writable).map(
      (repository) => repository.name,
    ),
    crossRepositoryVerification,
    setupOrder,
    repositories,
    failures,
    metrics: {
      elapsedMilliseconds: Math.round(performance.now() - started),
      peakChildProcesses: peakChildren,
      remainingChildProcesses: activeChildren,
      logicalBytesAtPeak: peakUsage.logicalBytes,
      allocatedBytesAtPeak: peakUsage.allocatedBytes,
      logicalBytesAfterCleanup: afterCleanup.logicalBytes,
      allocatedBytesAfterCleanup: afterCleanup.allocatedBytes,
    },
    cleanup: { requested: cleanup, completed: cleanupCompleted, idempotent: cleanupIdempotent },
  };
}

export async function advanceQ033Remote(
  rootPath: string,
  repository: RepositoryName,
): Promise<string> {
  const seedPath = join(rootPath, "seeds", repository);
  await writeFile(join(seedPath, "remote-advance.txt"), `${Date.now()}\n`, "utf8");
  await git(seedPath, "add", "remote-advance.txt");
  await git(seedPath, "commit", "-m", "advance remote after interruption");
  await git(seedPath, "push", "origin", "main");
  return git(seedPath, "rev-parse", "HEAD");
}

export async function corruptQ033Journal(rootPath: string): Promise<void> {
  await writeFile(join(rootPath, "workspaces", "ws_q033", JOURNAL_NAME), "{not-json\n", "utf8");
}
