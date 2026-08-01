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
 * Q007 updated the `ArtifactRef/v1` sha256 (from `d0c79064…` to `331609e8…`)
 * to cover six added fields (`name`, `byteLength`, `mediaType`,
 * `contentSchemaId`, `producer`, `sourceLineage`). The schema was extended in
 * place rather than versioned to `v2` because it had zero non-test consumers
 * at the time (`grep -c artifactId packages/conformance/generated/*.json` →
 * 0), so no existing payload's shape changed. The other thirteen entries stay
 * byte-identical and the schema count stays 14 — this single pin update is
 * itself the deliberate versioning act the gate exists to force.
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
    sha256: "331609e8e110768c346051640ce31d8a301df46a7a645b3ac96274d4ec9d4b44",
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
    schemaId: "heniek://contract/TaskContext/v1",
    schemaVersion: 1,
    sha256: "bba19a9bb7a0647c6e80babe821b020650f4fb702fcffb629a1ac57ff56eaa6a",
    path: "generated/TaskContext.v1.schema.json",
  },
];

describe("packages/contracts generated manifest is unchanged (AC4)", () => {
  it("manifest.json lists exactly the 14 known schemas with their recorded sha256", async () => {
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
