import { describe, expect, it } from "vitest";
import {
  CLAUDEXOR_RUNTIME_AUTHORITY,
  parseAndVerifyRuntimeManifest,
  runtimeArchiveUrl,
} from "../src/release.js";

const signedManifest = {
  schemaVersion: 1,
  version: "3.1.2",
  sha256: "28b54f20723b866eefdba1ebcbc4311da5c03f0828e72073947087ba092a6a4e",
  minAppVersion: "2.1.0",
  archiveName: "claudexor-runtime-3.1.2.tar.gz",
  archiveUrl:
    "https://github.com/razzant/claudexor/releases/download/v3.1.2/claudexor-runtime-3.1.2.tar.gz",
  buildSha: "bb5efee24132aa3d65e417040df201e08da44c8c",
  notes:
    "Delegate recovery patch. Packaged macOS and npm installs now expose the six-tool delegation belt through the exact daemon self-entry instead of failing because a neighboring `cli.js` is absent. Claude Code and Codex treat the injected MCP server as required: a known pre-start incompatibility continues as ordinary Agent only with a durable, visible requested/effective/used/reason/remediation receip",
  keyId: "claudexor-runtime-update-v3.1.0-ed25519-ce7f15e6187e137d",
  algorithm: "Ed25519",
  signature:
    "SHl/O3sO0aFw+ih6hlpgOCCSllKrlKC/n1ZKcDcFEpv6BGA8xTSVSXp5MFNTX7khNGckK11T7PjkVZb3fyxPDQ==",
} as const;

describe("Claudexor signed runtime release", () => {
  it("accepts the pinned upstream v3.1.2 manifest and authority", () => {
    expect(parseAndVerifyRuntimeManifest(signedManifest, "3.1.2")).toEqual(signedManifest);
    expect(CLAUDEXOR_RUNTIME_AUTHORITY.algorithm).toBe("Ed25519");
  });

  it.each([
    ["signature", { ...signedManifest, signature: `${signedManifest.signature.slice(0, -2)}AA` }],
    ["version", { ...signedManifest, version: "3.1.3" }],
    ["archive URL", { ...signedManifest, archiveUrl: "https://example.invalid/runtime.tgz" }],
    ["key", { ...signedManifest, keyId: "unknown-key" }],
  ])("rejects a mismatched %s", (_label, manifest) => {
    expect(() => parseAndVerifyRuntimeManifest(manifest, "3.1.2")).toThrow();
  });

  it("derives only the fixed upstream archive location", () => {
    expect(runtimeArchiveUrl("3.1.2")).toBe(signedManifest.archiveUrl);
  });
});
