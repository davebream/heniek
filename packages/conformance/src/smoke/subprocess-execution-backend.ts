import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  ArtifactId,
  ExecutionBackend,
  ExecutionStatus as ExecutionStatusValue,
  InteractionId,
} from "@heniek/contracts";
import {
  ExecutionRequestV1,
  type ExecutionResultV1,
  ExecutionStatus,
  type PendingInteractionV1,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import type { ExecutionArrangement, PendingInteractionKind } from "../contract/arrangement.js";
import { ConformanceFaultError } from "../contract/fault.js";
import {
  type ConformanceSubject,
  EXECUTION_BACKEND_TRACE_ACTIONS,
  TRACE_ACTORS,
} from "../contract/harness.js";
import { assertValid } from "../contract/validation.js";
import type { ConformanceContext } from "../kernel/context.js";

type ExecutionResult = Static<typeof ExecutionResultV1>;
type PendingInteraction = Static<typeof PendingInteractionV1>;

/**
 * The capabilities this bundled adapter genuinely honours (design §6): a
 * real process lifecycle, real interaction, real SIGTERM cancellation, a
 * real malformed-output path, and — because `requireRun` genuinely throws
 * `stale_ref` for an unknown run id, the same as every other subject —
 * `fault-stale-ref`. It deliberately omits `resume` and the remaining
 * `fault-*` capabilities: no fault injection or crash-recovery axis exists
 * for a real child process, and that's the point: it proves the capability
 * mechanism lets a genuinely-real subject decline coverage it cannot honour.
 *
 * Exported as a single module constant so `src/smoke/harness.ts` and
 * `src/matrix.ts` share the exact same list and can never disagree
 * (plan Phase 8.1).
 */
export const SMOKE_SUBPROCESS_CAPABILITIES = [
  "lifecycle",
  "interaction",
  "cancellation",
  "malformed-response",
  "fault-stale-ref",
] as const;

/** A bounded real-time wait for child I/O — allowed only under `src/smoke/**` (see no-wall-clock.test.ts). */
const SMOKE_IO_TIMEOUT_MS = 15_000;

interface Directive {
  readonly mode: "succeed" | "fail" | "question" | "malformed";
  readonly interactionKind?: PendingInteractionKind;
}

function directiveFor(arrangement: ExecutionArrangement | undefined): Directive {
  if (arrangement === undefined) {
    return { mode: "succeed" };
  }
  switch (arrangement.kind) {
    case "completes":
      return { mode: arrangement.status === "failed" ? "fail" : "succeed" };
    case "asks-question":
      return { mode: "question", interactionKind: arrangement.interactionKind };
    case "emits-malformed-result":
      return { mode: "malformed" };
    case "injects-fault":
      // This adapter declares no fault-* capability, so no catalogue case
      // ever reaches this branch; kept exhaustive for type safety only.
      return { mode: "succeed" };
    default:
      return { mode: "succeed" };
  }
}

/**
 * The child process programme, embedded as a plain string constant (a `.ts`
 * module, never a `.js` file added to the repository — `allowJs: false`
 * stays true). Speaks NDJSON on stdout: `ready` → optional `question` →
 * `result`, then exits 0. `malformed` mode emits a non-JSON line instead of
 * a `result` and exits 0, to exercise the malformed-response path honestly.
 */
export const CHILD_PROGRAMME = `
const readline = require("node:readline");
const directive = JSON.parse(process.argv[process.argv.length - 1]);
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}
send({ type: "ready" });
if (directive.mode === "malformed") {
  process.stdout.write("conformance-smoke-non-json-output\\n");
  process.exit(0);
} else if (directive.mode === "question") {
  const kind = directive.interactionKind || "free_text";
  const question = { type: "question", id: "conformance-smoke-question-1", kind, prompt: "Conformance smoke question." };
  if (kind !== "free_text") {
    question.options = ["conformance-option-a", "conformance-option-b"];
  }
  send(question);
  rl.once("line", () => {
    send({ type: "result", status: "succeeded", summary: "Answered and completed.", artifacts: {} });
    process.exit(0);
  });
} else if (directive.mode === "fail") {
  send({ type: "result", status: "failed", summary: "Conformance smoke failure.", artifacts: {} });
  process.exit(0);
} else {
  send({ type: "result", status: "succeeded", summary: "Completed without interaction.", artifacts: {} });
  process.exit(0);
}
`;

type RawMessage =
  | { readonly type: "ready" }
  | {
      readonly type: "question";
      readonly id: string;
      readonly kind: PendingInteractionKind;
      readonly prompt: string;
      readonly options?: string[];
    }
  | {
      readonly type: "result";
      readonly status: "succeeded" | "failed";
      readonly summary: string;
      readonly artifacts?: Record<string, string>;
    }
  | { readonly type: "malformed" };

interface SmokeRunRecord {
  readonly child: ChildProcessByStdio<Writable, Readable, null>;
  readonly events: EventEmitter;
  readonly queue: RawMessage[];
  status: ExecutionStatusValue;
  pendingInteraction: PendingInteraction | undefined;
  askedInteractionId: InteractionId | undefined;
  result: ExecutionResult | undefined;
  malformed: boolean;
  exited: boolean;
  cancelled: boolean;
  /** Set by the child's `"error"` event — a spawn failure (EACCES/EAGAIN/ENOENT/EPERM/…). */
  spawnError: Error | undefined;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

/**
 * Waits for `event` on `emitter`, bounded by `AbortSignal.timeout()` rather
 * than a bare `setTimeout` raced via `Promise.race` (MAJOR-4). The prior
 * version's `setTimeout` fired regardless of which side of the race won —
 * only its *rejection* was ignored — leaving a live timer (and its rejected,
 * unhandled promise) for up to `SMOKE_IO_TIMEOUT_MS` after the awaited event
 * had already resolved the race. `AbortSignal.timeout()`'s internal timer is
 * unref'd and is cleared by `once()` itself the moment either side settles.
 */
async function waitForEvent(emitter: EventEmitter, event: string, label: string): Promise<void> {
  try {
    await once(emitter, event, { signal: AbortSignal.timeout(SMOKE_IO_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`smoke subprocess adapter timed out: ${label}`, { cause: error });
  }
}

async function nextMessage(record: SmokeRunRecord): Promise<RawMessage> {
  if (record.spawnError !== undefined) {
    throw record.spawnError;
  }
  const queued = record.queue.shift();
  if (queued !== undefined) {
    return queued;
  }
  await waitForEvent(record.events, "message", "waiting for child output");
  if (record.spawnError !== undefined) {
    throw record.spawnError;
  }
  const next = record.queue.shift();
  if (next === undefined) {
    throw new Error("smoke subprocess adapter observed no queued message after waking");
  }
  return next;
}

function applyMessage(record: SmokeRunRecord, message: RawMessage): void {
  if (message.type === "malformed") {
    record.malformed = true;
    record.status = "succeeded";
    return;
  }
  if (message.type === "ready") {
    record.status = "running";
    return;
  }
  if (message.type === "question") {
    record.status = "waiting_on_user";
    record.askedInteractionId = message.id as InteractionId;
    record.pendingInteraction = {
      schemaVersion: 1,
      id: message.id as InteractionId,
      kind: message.kind,
      prompt: message.prompt,
      ...(message.options !== undefined ? { options: message.options } : {}),
    };
    return;
  }
  // result
  record.status = message.status;
  record.result = {
    schemaVersion: 1,
    status: message.status,
    summary: message.summary,
    changedRepositories: [],
    artifacts: (message.artifacts ?? {}) as Record<string, ArtifactId>,
  };
}

async function ensureUpToDate(record: SmokeRunRecord): Promise<void> {
  if (ExecutionStatus.isTerminal(record.status) || record.status === "waiting_on_user") {
    return;
  }
  const message = await nextMessage(record);
  applyMessage(record, message);
}

export interface SubprocessExecutionBackend {
  readonly backend: ExecutionBackend;
  /** Arranges the behaviour of the next run to be spawned. */
  arrange(arrangement: ExecutionArrangement): void;
  dispose(): Promise<void>;
}

export function createSubprocessExecutionBackend(
  context: ConformanceContext,
): SubprocessExecutionBackend {
  const runs = new Map<string, SmokeRunRecord>();
  let pendingArrangement: ExecutionArrangement | undefined;

  function requireRun(runId: string): SmokeRunRecord {
    const run = runs.get(runId);
    if (run === undefined) {
      throw new ConformanceFaultError("stale_ref", false, `unknown run id: ${runId}`);
    }
    return run;
  }

  const backend: ExecutionBackend = {
    async start(request: Static<typeof ExecutionRequestV1>): Promise<string> {
      assertValid(ExecutionRequestV1, request, "ExecutionRequestV1");
      const arrangement = pendingArrangement;
      pendingArrangement = undefined;
      const directive = directiveFor(arrangement);

      const runId = context.ids.next("smoke-run");
      const child = spawn(
        process.execPath,
        ["-e", CHILD_PROGRAMME, "--", JSON.stringify(directive)],
        {
          // stderr is never read by this adapter — piping it without a
          // drain risks the child blocking once its stderr pipe buffer
          // fills (>64 KiB); "ignore" discards it at the OS level instead
          // (NEW-9). This child never writes to stderr in any mode, so
          // nothing is lost.
          stdio: ["pipe", "pipe", "ignore"],
          detached: false,
        },
      );

      const events = new EventEmitter();
      const record: SmokeRunRecord = {
        child,
        events,
        queue: [],
        status: "queued",
        pendingInteraction: undefined,
        askedInteractionId: undefined,
        result: undefined,
        malformed: false,
        exited: false,
        cancelled: false,
        spawnError: undefined,
        exitCode: null,
        exitSignal: null,
      };
      runs.set(runId, record);

      const rl = createInterface({ input: child.stdout, terminal: false });
      rl.on("line", (line: string) => {
        try {
          const parsed = JSON.parse(line) as RawMessage;
          record.queue.push(parsed);
        } catch {
          record.queue.push({ type: "malformed" });
        }
        events.emit("message");
      });
      child.on("exit", (code, signal) => {
        record.exited = true;
        record.exitCode = code;
        record.exitSignal = signal;
        events.emit("message");
      });
      // Without this handler, a spawn failure (EACCES/EAGAIN/ENOENT/EPERM/…)
      // emits `"error"` on the `ChildProcess` with no listener attached,
      // which throws asynchronously outside any case's `try` — killing the
      // whole worker rather than failing the one case, and skipping
      // `dispose()` entirely (NEW-5). Recording it on the run instead lets
      // `nextMessage`/`ensureUpToDate` surface it as a normal case failure.
      child.on("error", (error: Error) => {
        record.spawnError = error;
        record.exited = true;
        events.emit("message");
      });

      // Deliberately does NOT wait for the child's "ready" handshake here:
      // `record.status` stays "queued" until the first `status()` poll
      // consumes it, exactly mirroring the fakes' contract (`start()` never
      // advances the phase itself; each subsequent poll advances exactly
      // one step). Consuming "ready" here too would leave only one poll's
      // worth of progress before terminal, one fewer than the fakes give —
      // a real defect this adapter hit: the very fast bundled child writes
      // "ready" and its result back-to-back, so pre-consuming "ready" in
      // start() let the first status() poll immediately observe a terminal
      // result, violating "status() is non-terminal immediately after
      // start()" (see test/regressions.test.ts).
      context.trace.record({
        atMs: context.clock.nowMs(),
        // Shared, family-level actor/action labels (not this adapter's own
        // implementation name) — see the trace-recording obligation
        // documented on `ConformanceHarness` — so a case that inspects the
        // trace is portable across every ExecutionBackend implementation,
        // not coupled to this bundled adapter's naming.
        actor: TRACE_ACTORS.executionBackend,
        action: EXECUTION_BACKEND_TRACE_ACTIONS.start,
        outcome: "ok",
        detail: { runId },
      });
      return runId;
    },

    async status(runId: string): Promise<ExecutionStatusValue> {
      const record = requireRun(runId);
      await ensureUpToDate(record);
      return record.status;
    },

    async interactions(runId: string): Promise<PendingInteraction[]> {
      const record = requireRun(runId);
      return record.status === "waiting_on_user" && record.pendingInteraction !== undefined
        ? [record.pendingInteraction]
        : [];
    },

    async answer(runId: string, interactionId: InteractionId, answer: unknown): Promise<void> {
      const record = requireRun(runId);
      if (ExecutionStatus.isTerminal(record.status)) {
        throw new ConformanceFaultError("conflict", false, "answer requested after terminal");
      }
      if (record.status !== "waiting_on_user" || record.askedInteractionId !== interactionId) {
        throw new ConformanceFaultError("stale_ref", false, "unknown interaction id");
      }
      record.child.stdin.write(`${JSON.stringify({ interactionId, answer })}\n`);
      record.pendingInteraction = undefined;
      record.status = "running";
    },

    async resume(_runId: string, _inputArtifactRefs: ArtifactId[]): Promise<void> {
      throw new Error("resume() is not supported by the subprocess smoke adapter");
    },

    async result(runId: string): Promise<ExecutionResult> {
      const record = requireRun(runId);
      if (!ExecutionStatus.isTerminal(record.status)) {
        throw new ConformanceFaultError("conflict", false, "result requested before terminal");
      }
      if (record.malformed) {
        throw new ConformanceFaultError(
          "malformed_response",
          false,
          "child produced a non-JSON final line",
        );
      }
      if (record.result === undefined) {
        throw new Error("smoke subprocess adapter reached terminal without a captured result");
      }
      return record.result;
    },

    async cancel(runId: string): Promise<void> {
      const record = requireRun(runId);
      if (!record.cancelled) {
        record.cancelled = true;
        if (!record.exited) {
          record.child.kill("SIGTERM");
          // Real SIGTERM cancellation with exit-code/signal observation
          // (design §6): the child is a single, non-detached process that
          // never spawns children of its own, so there is no process *tree*
          // to reap here — only the one child, captured above by the
          // `"exit"` listener into `record.exitCode`/`record.exitSignal`.
          await waitForEvent(record.child, "exit", "waiting for cancelled child to exit").catch(
            () => undefined,
          );
        }
      }
      record.status = "cancelled";
      record.pendingInteraction = undefined;
      record.result = {
        schemaVersion: 1,
        status: "cancelled",
        summary: `Conformance smoke run ${runId} cancelled.`,
        changedRepositories: [],
        artifacts: {},
      };
    },
  };

  return {
    backend,
    arrange(arrangement: ExecutionArrangement): void {
      pendingArrangement = arrangement;
    },
    async dispose(): Promise<void> {
      for (const record of runs.values()) {
        if (!record.exited) {
          record.child.kill("SIGKILL");
        }
      }
    },
  };
}

/** Builds a fresh `ConformanceSubject` around a subprocess backend for one case. */
export function createSubprocessExecutionBackendSubject(
  context: ConformanceContext,
): ConformanceSubject<ExecutionBackend, ExecutionArrangement> {
  const adapter = createSubprocessExecutionBackend(context);
  return {
    subject: adapter.backend,
    async arrange(arrangement: ExecutionArrangement): Promise<void> {
      adapter.arrange(arrangement);
    },
    async dispose(): Promise<void> {
      await adapter.dispose();
    },
  };
}
