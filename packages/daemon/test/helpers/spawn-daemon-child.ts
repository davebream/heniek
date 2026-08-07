/**
 * Parent-side plumbing for spawning `daemon-child.ts` as a real process
 * (plan Task 6 Steps 2-5). Shared by `parallel-start.test.ts`,
 * `stale-files.test.ts`, and `signals.test.ts` so the spawn/wait/kill
 * discipline — and its determinism guarantees — lives in exactly one place.
 *
 * Every wait here is a bounded, named failure (`AbortSignal.timeout`), never
 * a fixed `sleep` and never a bare, unbounded event wait (plan Task 6 Step
 * 12: "no sleep, no poll, no elapsed-time assertion anywhere").
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ApplicationHome,
  ensureApplicationHomeDirectories,
  resolveApplicationHome,
} from "@heniek/config";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const daemonChildPath = resolve(packageRoot, "test/helpers/daemon-child.ts");

const LINE_DEADLINE_MS = 30_000;
const CLOSE_DEADLINE_MS = 30_000;

export interface TempDaemonHome {
  /** The `mkdtemp`-created root, outside the checkout (IR-31/OR-14) — also the `HENIEK_HOME` value both parent and child resolve against. */
  readonly directory: string;
  readonly home: ApplicationHome;
}

/**
 * A real `mkdtemp` home outside the repository, already `ensure`d (so
 * `runtimeDirectory` exists at `0700` and every other layout entry is
 * materialised) — the child re-runs `ensureApplicationHomeDirectories`
 * itself too (idempotent), matching how a real daemon start is bootstrapped.
 */
export async function createTempDaemonHome(): Promise<TempDaemonHome> {
  const directory = await mkdtemp(join(tmpdir(), "heniek-daemon-child-"));
  const home = resolveApplicationHome({
    platform: "linux",
    env: { HENIEK_HOME: directory },
    homeDirectory: directory,
  });
  await ensureApplicationHomeDirectories(home);
  return { directory, home };
}

export interface ChildCloseResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ChildHandle {
  readonly child: ChildProcess;
  /** Resolves the moment the child's `"close"` event fires. Subscribed at spawn time (never on first await), so a fast-exiting child cannot be missed. */
  readonly closed: Promise<ChildCloseResult>;
  /** Registers a callback invoked once per parsed NDJSON stdout line, in order. */
  onLine(callback: (line: unknown) => void): void;
  /** Writes one NDJSON line to the child's stdin — the drain-gate release mechanism (plan Task 6 Step 3b). */
  writeStdin(line: unknown): void;
  /** The child's stderr collected so far — diagnostic only, never asserted on. */
  stderr(): string;
}

export type DaemonChildDirective =
  | { readonly mode: "start"; readonly homeDirectory: string; readonly drainGate?: boolean }
  | { readonly mode: "hang-after-takeover-rename"; readonly homeDirectory: string };

/** Spawns `daemon-child.ts` via the repo's existing `tsx` runner (no new runtime dependency). */
export function spawnDaemonChild(directive: DaemonChildDirective): ChildHandle {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", daemonChildPath, JSON.stringify(directive)],
    {
      // So `--import tsx` resolves from packages/daemon/node_modules.
      cwd: packageRoot,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    },
  );

  let buffer = "";
  let stderr = "";
  const lineCallbacks: Array<(line: unknown) => void> = [];

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const raw = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (raw.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      for (const callback of lineCallbacks) {
        callback(parsed);
      }
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // Subscribed here, unconditionally, the moment the child is spawned — a
  // child that exits within microseconds of a signal must still be caught.
  const closed = new Promise<ChildCloseResult>((resolveClosed) => {
    child.once("close", (code, signal) => {
      resolveClosed({ code, signal });
    });
  });

  return {
    child,
    closed,
    onLine: (callback) => lineCallbacks.push(callback),
    writeStdin: (line) => {
      child.stdin?.write(`${JSON.stringify(line)}\n`);
    },
    stderr: () => stderr,
  };
}

export type LineOrClose =
  | { readonly kind: "line"; readonly line: unknown }
  | { readonly kind: "closed"; readonly result: ChildCloseResult };

/**
 * Waits for the first NDJSON line satisfying `predicate`, racing it against
 * the child's own close event — a child that exits without ever producing a
 * matching line resolves immediately with `"closed"` rather than hanging
 * until the deadline. Bounded by `AbortSignal.timeout` as the outer failure
 * backstop, never as a pacing device (plan Task 6 Step 12).
 */
export function waitForLineOrClose(
  handle: ChildHandle,
  predicate: (line: unknown) => boolean,
): Promise<LineOrClose> {
  return new Promise((resolveWait, rejectWait) => {
    let settled = false;
    const abortSignal = AbortSignal.timeout(LINE_DEADLINE_MS);

    function onAbort(): void {
      if (settled) {
        return;
      }
      settled = true;
      rejectWait(
        new Error(
          `daemon-child (pid ${handle.child.pid}) produced neither a matching line nor closed ` +
            `within ${LINE_DEADLINE_MS}ms.\n--- stderr ---\n${handle.stderr()}`,
        ),
      );
    }

    abortSignal.addEventListener("abort", onAbort, { once: true });

    handle.onLine((line) => {
      if (settled || !predicate(line)) {
        return;
      }
      settled = true;
      abortSignal.removeEventListener("abort", onAbort);
      resolveWait({ kind: "line", line });
    });

    handle.closed.then((result) => {
      if (settled) {
        return;
      }
      settled = true;
      abortSignal.removeEventListener("abort", onAbort);
      resolveWait({ kind: "closed", result });
    });
  });
}

/** A bounded, named wait for a specific line — throws if the child closes first or the deadline fires. */
export async function waitForLine(
  handle: ChildHandle,
  predicate: (line: unknown) => boolean,
): Promise<unknown> {
  const outcome = await waitForLineOrClose(handle, predicate);
  if (outcome.kind === "closed") {
    throw new Error(
      `daemon-child (pid ${handle.child.pid}) closed (code=${outcome.result.code}, ` +
        `signal=${outcome.result.signal}) before producing a matching line.\n` +
        `--- stderr ---\n${handle.stderr()}`,
    );
  }
  return outcome.line;
}

/**
 * A bounded, named wait for process exit — a failure bound, never a pacing
 * device (plan Task 6 Step 12: every child-exit wait must be bounded, never
 * a bare `once(child, "close")`).
 */
export async function waitForChildClose(handle: ChildHandle): Promise<ChildCloseResult> {
  const [code, signal] = (await once(handle.child, "close", {
    signal: AbortSignal.timeout(CLOSE_DEADLINE_MS),
  })) as [number | null, NodeJS.Signals | null];
  return { code, signal };
}
