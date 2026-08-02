/**
 * The real `HostWitness` adapter (design C1 step 6, plan Task 5 Steps 7 and
 * 8) — a boot-scoped value distinguishing a claim record written during
 * *this* boot from a stale record surviving a reboot with pid reuse.
 *
 * Linux: `/proc/sys/kernel/random/boot_id`, a kernel-generated UUID that
 * changes on every boot. Darwin: `sysctl kern.boottime`, the wall-clock
 * boot timestamp — not itself a UUID, but stable within a boot and distinct
 * across reboots, which is the only property `acquire.ts`'s witness-match
 * check needs. Every other platform: `undefined`, which downgrades a claim
 * record to *witness-unobtainable* and routes it to takeover rather than
 * failing (design C1 step 6) — this module never throws.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { HostWitness } from "../ports.js";

const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

function readLinuxBootId(): string | undefined {
  try {
    const raw = readFileSync(LINUX_BOOT_ID_PATH, "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

function readDarwinBootTime(): string | undefined {
  try {
    const raw = execFileSync("sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function createSystemHostWitness(): HostWitness {
  return {
    current(): string | undefined {
      if (process.platform === "linux") {
        return readLinuxBootId();
      }
      if (process.platform === "darwin") {
        return readDarwinBootTime();
      }
      return undefined;
    },
  };
}
