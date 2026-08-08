import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PS_COMMAND = "ps";
const PS_ARGUMENTS = ["-axo", "pid=,ppid="] as const;

export interface ProcessSnapshot {
  readonly instrument: "ps";
  readonly rootPid: number;
  readonly descendantCount: number;
}

export interface ProcessSnapshotOptions {
  readonly rootPid: number;
  readonly run?: (command: string, args: readonly string[]) => Promise<{ readonly stdout: string }>;
}

/**
 * Counts current descendants of one daemon PID without retaining command output.
 *
 * A process can exit or be reparented between samples, so callers must report
 * this only as indicative compatibility evidence, never as tree-empty proof.
 */
export async function sampleProcessSnapshot(
  options: ProcessSnapshotOptions,
): Promise<ProcessSnapshot> {
  const run =
    options.run ??
    (async (command: string, args: readonly string[]) => {
      const { stdout } = await execFileAsync(command, args, { encoding: "utf8" });
      return { stdout };
    });
  const { stdout } = await run(PS_COMMAND, PS_ARGUMENTS);
  const parents = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/u);
    const pid = Number(pidText);
    const parentPid = Number(parentText);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(parentPid)) parents.set(pid, parentPid);
  }
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parentPid] of parents) {
      if ((parentPid === options.rootPid || descendants.has(parentPid)) && !descendants.has(pid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return { instrument: "ps", rootPid: options.rootPid, descendantCount: descendants.size };
}
