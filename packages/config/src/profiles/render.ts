import { redactJson } from "@heniek/secrets";
import { canonicalJsonStringify, type JsonObject } from "../json.js";
import type { ResolvedProfile } from "./types.js";

/** Redacted plain-JSON snapshot suitable for artifacts and diagnostics. */
export function toResolvedProfileSnapshot(profile: ResolvedProfile): JsonObject {
  return redactJson(profile) as JsonObject;
}

export function renderResolvedProfileSnapshot(profile: ResolvedProfile): string {
  return canonicalJsonStringify(toResolvedProfileSnapshot(profile));
}
