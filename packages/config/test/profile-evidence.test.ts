import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toResolvedProfileSnapshot } from "../src/profiles/index.js";
import { EVIDENCE_PROFILE_IDS, resolveEvidenceProfile } from "./helpers/profile-evidence.js";

const resolvedEvidencePath = fileURLToPath(
  new URL("../../../docs/adr/evidence/0013-q014-resolved-profiles.json", import.meta.url),
);
const invalidEvidencePath = fileURLToPath(
  new URL("../../../docs/adr/evidence/0013-q014-invalid-diagnostics.json", import.meta.url),
);

describe("Q014 evidence drift", () => {
  it("matches the committed resolved-profile snapshots and capability matrix", async () => {
    const profiles = Object.fromEntries(
      EVIDENCE_PROFILE_IDS.map((profileId) => {
        const result = resolveEvidenceProfile(profileId);
        if (!result.ok) throw new Error(`evidence fixture ${profileId} failed`);
        return [profileId, toResolvedProfileSnapshot(result.profile)];
      }),
    );
    const capabilityMatrix = EVIDENCE_PROFILE_IDS.map((profileId) => {
      const profile = profiles[profileId] as Record<string, unknown>;
      return {
        ...(profile.accountId !== undefined ? { accountId: profile.accountId } : {}),
        effort: profile.effort,
        engine: profile.engine,
        executionMode: profile.executionMode,
        fingerprint: profile.fingerprint,
        model: profile.model,
        profileId: profile.profileId,
      };
    });
    const evidence = JSON.parse(await readFile(resolvedEvidencePath, "utf8"));

    expect(evidence).toEqual({
      capabilityMatrix,
      snapshots: {
        claudeExternal: profiles["claude-external"],
        claudeNative: profiles["claude-native"],
      },
    });
  });

  it("matches the committed invalid-combination diagnostics", async () => {
    const expected = {
      mismatchedAccount: resolveEvidenceProfile("claude-external", { account: "codex-main" })
        .diagnostics,
      unknownModel: resolveEvidenceProfile("claude-external", { model: "unknown-model" })
        .diagnostics,
      unsupportedEffort: resolveEvidenceProfile("claude-external", { effort: "ultra" }).diagnostics,
    };
    const evidence = JSON.parse(await readFile(invalidEvidencePath, "utf8"));

    expect(evidence).toEqual(expected);
  });
});
