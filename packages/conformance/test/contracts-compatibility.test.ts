import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_REGISTRY } from "@heniek/contracts";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(packageRoot, "../contracts/generated/manifest.json");

/**
 * Pinned from `packages/contracts/generated/manifest.json` at the time this
 * package was added. This is the AC4 gate: if `packages/contracts/src/**`
 * ever changes in a way that regenerates a different hash — or adds/removes
 * a schema — this test fails immediately, rather than silently drifting.
 *
 * Q005 raised the pin from 12 to 14 schemas, adding `ApplicationHome/v1` and
 * `ResolvedConfiguration/v1`. Updating this list is the *deliberate versioning
 * act* the gate exists to force; what makes the change compatible rather than
 * breaking is that the other twelve entries below are byte-identical to their
 * previous values, so no existing consumer's payload changed shape.
 *
 * General rule: an already-pinned schema digest may change in place —
 * without bumping to a new version — only while that schema's consumer set
 * is provably empty, and the proof must be recorded with the change. Bumping
 * a digest for a schema with even one real consumer would silently change
 * the shape of a payload someone already depends on; that is exactly the
 * breaking change this gate exists to catch.
 *
 * Q007 updated the `ArtifactRef/v1` sha256 twice (most recently to
 * `60de8785…`) to add six new REQUIRED properties (`name`, `byteLength`,
 * `mediaType`, `contentSchemaId`, `producer`, `sourceLineage`) and to
 * pattern-constrain `contentSchemaId`. Adding required properties to a
 * closed (`additionalProperties: false`) schema, and further constraining
 * an existing string field, are both breaking changes under normal semver:
 * any real payload built against the old shape would now fail validation.
 * This in-place edit is deliberately chosen over minting `ArtifactRef/v2`
 * only because there is nothing to migrate: `ArtifactRefV1` is a
 * pre-release, zero-consumer schema. Evidence: (1) `packages/contracts` is
 * `"private": true` (`packages/contracts/package.json`) — it is never
 * published, so there is no external consumer by construction; (2) a
 * repo-wide grep for the `ArtifactRefV1` symbol
 * (`grep -rn "ArtifactRefV1" --include="*.ts" packages | grep -v
 * packages/contracts`) finds zero references outside `packages/contracts`
 * itself (the only hit is this file's own docblock) — no in-repo production
 * code constructs or reads an `ArtifactRefV1` payload yet, and no `artifact`
 * table exists to hold one. The other thirteen entries stay byte-identical
 * and the schema count stays 14 — this pin update is itself the deliberate,
 * evidence-backed act of accepting a breaking change against an
 * unpublished, unconsumed schema, not a "versioning act" in the semver
 * sense.
 *
 * Q008 raised the count 14 → 19 by **pure addition**: five new schemas —
 * `DaemonHelloResult/v1`, `DaemonRequestAuth/v1`,
 * `DaemonCredentialRotation/v1`, `DaemonStatus/v1`, and
 * `RunRecoveryClassification/v1` (the daemon's local-control surface and its
 * crash-recovery classification result). No existing entry was altered —
 * all fourteen pre-Q008 `sha256` values below are byte-identical to their
 * prior values. `RunRecoveryClass` is a plain tuple, not a `RunStatus`
 * value, so `Run/v1`'s pinned `be0a661b93de…` also stays untouched.
 */
const EXPECTED_SCHEMAS: readonly {
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly sha256: string;
  readonly path: string;
}[] = [
  {
    schemaId: "heniek://contract/ApplicationHome/v1",
    schemaVersion: 1,
    sha256: "a0ba4f81c226ec8201cbe2a2110fcd5793df84689db95a53fb7db1553fea4fe8",
    path: "generated/ApplicationHome.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ArtifactRef/v1",
    schemaVersion: 1,
    sha256: "60de8785feb0de6a90fc0de55fcead8dc060ddf5fa46aaa4980ba2d2ad0a2410",
    path: "generated/ArtifactRef.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CheckFailure/v1",
    schemaVersion: 1,
    sha256: "08fd624553b1bd77818bd211863dcbcf8fe093dd2ef61e9198e428a8a765bda4",
    path: "generated/CheckFailure.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CheckStatus/v1",
    schemaVersion: 1,
    sha256: "1e1c19760ac29c4135d2d71018e5730118c27210829ca1256b5d768a19fdaf64",
    path: "generated/CheckStatus.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CreatePullRequestInput/v1",
    schemaVersion: 1,
    sha256: "55873424bc47a8bd87d409ef294271c8fd81d1b7a6111b92bb8501f782dba79c",
    path: "generated/CreatePullRequestInput.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/DaemonCredentialRotation/v1",
    schemaVersion: 1,
    sha256: "65e3c3e630db735f111349c152cad0689ec622ab24236d2cef24d9fd099fe38a",
    path: "generated/DaemonCredentialRotation.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/DaemonHelloResult/v1",
    schemaVersion: 1,
    sha256: "238a2a706c495f67986ba079f6e6abe15ba80c33ec56f19de3992ac15778470b",
    path: "generated/DaemonHelloResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/DaemonRequestAuth/v1",
    schemaVersion: 1,
    sha256: "1f831c8b10a4df7001fc99ee2c425ad8a42bd911380f0a22a1907db3545781d1",
    path: "generated/DaemonRequestAuth.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/DaemonStatus/v1",
    schemaVersion: 1,
    sha256: "a91375e3509ceb2663a96e656d18e32c722085a1cb574328159cee7ff4fef854",
    path: "generated/DaemonStatus.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionRequest/v1",
    schemaVersion: 1,
    sha256: "0642730af967d4a595cf4855a738e975b8577f6e18c6c1cb4e75a08be0edb02e",
    path: "generated/ExecutionRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionResult/v1",
    schemaVersion: 1,
    sha256: "7aabaff4e3b8450036a27c1c25ac299cd5d22a03b5feb7c2ea05657513ac7942",
    path: "generated/ExecutionResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/Interaction/v1",
    schemaVersion: 1,
    sha256: "3f1ceff9662dac675b46bb362e61068934b845ca650957698b3c2c577f3c171a",
    path: "generated/Interaction.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/InteractionAnswer/v1",
    schemaVersion: 1,
    sha256: "8d290caa830edd351698906634f6748080e6c682b776b0ba6cbda39e0bbc5a3d",
    path: "generated/InteractionAnswer.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PendingInteraction/v1",
    schemaVersion: 1,
    sha256: "18105638d2b12bdaeddd18b51e23d60b5e60ebdc9d0fe1f59dd831a86364ced9",
    path: "generated/PendingInteraction.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PullRequest/v1",
    schemaVersion: 1,
    sha256: "07c6c0fead0ade0271932b7f60262d84644c3097fed4462ca374f9a22496c0ef",
    path: "generated/PullRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ResolvedConfiguration/v1",
    schemaVersion: 1,
    sha256: "ab0ae9b99bb0e98c56e93665a92f049d86c3f43949f02764b0501b45e563fbd1",
    path: "generated/ResolvedConfiguration.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/Run/v1",
    schemaVersion: 1,
    sha256: "be0a661b93dee4b9f8a0c9b4e642864ebf99e94cbc4d06b3790b0a01bf2dc601",
    path: "generated/Run.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RunRecoveryClassification/v1",
    schemaVersion: 1,
    sha256: "0aee0e26d3e2d4434ec97ebdf41774720829842d4cec4a1dda823d2419577b13",
    path: "generated/RunRecoveryClassification.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskContext/v1",
    schemaVersion: 1,
    sha256: "bba19a9bb7a0647c6e80babe821b020650f4fb702fcffb629a1ac57ff56eaa6a",
    path: "generated/TaskContext.v1.schema.json",
  },
];

describe("packages/contracts generated manifest is unchanged (AC4)", () => {
  it("manifest.json lists exactly the 19 known schemas with their recorded sha256", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest).toEqual({
      schemaVersion: "heniek.contracts-manifest.v1",
      schemas: EXPECTED_SCHEMAS,
    });
  });

  it("SCHEMA_REGISTRY (imported for its registration side effect) has the same size and ids", () => {
    expect(SCHEMA_REGISTRY.size).toBe(EXPECTED_SCHEMAS.length);
    const registryIds = [...SCHEMA_REGISTRY.keys()].sort();
    const expectedIds = EXPECTED_SCHEMAS.map((schema) => schema.schemaId).sort();
    expect(registryIds).toEqual(expectedIds);
  });
});
