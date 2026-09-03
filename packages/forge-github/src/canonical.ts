import { createHash } from "node:crypto";
import type { ForgeObservedVersion } from "@heniek/contracts";

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function observedVersion(value: unknown): ForgeObservedVersion {
  return `sha256:${digest(value)}` as ForgeObservedVersion;
}
