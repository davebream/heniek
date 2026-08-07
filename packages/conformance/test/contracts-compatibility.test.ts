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
 * Q008 raised the count 14 → 18 by **pure addition**: four new schemas —
 * `DaemonHelloResult/v1`, `DaemonRequestAuth/v1`, `DaemonStatus/v1`, and
 * `RunRecoveryClassification/v1` (the daemon's local-control surface and its
 * crash-recovery classification result). No existing entry was altered —
 * all fourteen pre-Q008 `sha256` values below are byte-identical to their
 * prior values. `RunRecoveryClass` is a plain tuple, not a `RunStatus`
 * value, so `Run/v1`'s pinned `be0a661b93de…` also stays untouched.
 *
 * A fifth daemon schema, `DaemonCredentialRotation/v1`, was briefly added
 * and pinned (plan review round 1, finding M2) as the result contract for a
 * `daemon.rotateCredential` method, then removed again when plan review
 * round 2 (finding 13) withdrew that method. Removing a pinned schema is
 * normally exactly what this gate exists to block; it is admissible here on
 * the same zero-consumer evidence recorded above for `ArtifactRef/v1` — the
 * schema was added and removed within this unmerged branch, `@heniek/contracts`
 * is `"private": true` and never published, and a repo-wide grep for
 * `DaemonCredentialRotationV1` finds no reference outside the file that
 * declared it. Nothing ever constructed or read one.
 *
 * Q010 raised the count 26 → 33 by pure addition: Codebase detection and
 * registration request/result contracts, immutable instruction diagnostics
 * and snapshots, and `Run/v2`. `Run/v1` remains byte-identical for legacy
 * readers; execution readiness rejects legacy rows at the domain guard.
 *
 * Q012 raised the count 37 → 50 by pure addition: the provider-neutral V2
 * execution contracts and the bounded stage/run/artifact/doctor RPC results.
 * Every previously pinned V1 digest below remains byte-identical.
 *
 * Q015 raised the count 57 → 60 by pure addition: the capability catalogue,
 * catalogue request, and typed capability-selection failure. Every previously
 * pinned digest remains byte-identical.
 *
 * Q016 raises the count 60 → 61 by adding the provider-neutral V3 execution
 * event contract. Existing V1/V2 contracts remain byte-identical.
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
    schemaId: "heniek://contract/ArtifactGetResult/v1",
    schemaVersion: 1,
    sha256: "f7b3994c57cb536a8bcca368a33c38d24d5ffafaf60144ce3382e89a03d38223",
    path: "generated/ArtifactGetResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ArtifactRef/v1",
    schemaVersion: 1,
    sha256: "60de8785feb0de6a90fc0de55fcead8dc060ddf5fa46aaa4980ba2d2ad0a2410",
    path: "generated/ArtifactRef.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/BackendArtifact/v1",
    schemaVersion: 1,
    sha256: "ae7d30761009d12e602831b7bed7f729956baf515e8a40c10dbd7ba0f8d24091",
    path: "generated/BackendArtifact.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/BackendExecutionHandle/v1",
    schemaVersion: 1,
    sha256: "5de53f21b77c359b9b0c32c9ba197aab136b0cd8de3eed174f2a7aea0ab0fb8a",
    path: "generated/BackendExecutionHandle.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CapabilityCatalogue/v1",
    schemaVersion: 1,
    sha256: "5fe61be4e0fb222028c0078740e0b407250dddb911855a5dc14e15ed3a55a54c",
    path: "generated/CapabilityCatalogue.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CapabilityCatalogueRequest/v1",
    schemaVersion: 1,
    sha256: "73ca0ffa12a40f501d7d20ee11c96a5f6058d560a579c1f0c7c5bfac983de6e9",
    path: "generated/CapabilityCatalogueRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CapabilitySelectionError/v1",
    schemaVersion: 1,
    sha256: "1138fa35fe1661715fdf3a1359d59b216324d131c0e0ab57ac105575538965d5",
    path: "generated/CapabilitySelectionError.v1.schema.json",
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
    schemaId: "heniek://contract/CliStatusError/v1",
    schemaVersion: 1,
    sha256: "8509b5aa316d4df049d6f9d1101dbc649b9695e6d2d8592fb58ce05f12f92456",
    path: "generated/CliStatusError.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CliStatusResult/v1",
    schemaVersion: 1,
    sha256: "c50df283fcc7b4e847c92a1da17d80c9e5e9f3fea064404bf2598740b9d2ed3d",
    path: "generated/CliStatusResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CliStatusSuccess/v1",
    schemaVersion: 1,
    sha256: "5ddce29b0da219c88a64965c0c5f1131a0b4cdc7d482b46dda069f6d95144327",
    path: "generated/CliStatusSuccess.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CodebaseDetectionResult/v1",
    schemaVersion: 1,
    sha256: "0ff6101822ed1ba516ea106ace09d8a6f15fd5c8c8a605bf6b788cb43355b210",
    path: "generated/CodebaseDetectionResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CodebaseDetectRequest/v1",
    schemaVersion: 1,
    sha256: "7d9f6123957478c9d22b7379c9863d410aaa43d93a2840fd2e5f488db158672a",
    path: "generated/CodebaseDetectRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CodebaseRegisterRequest/v1",
    schemaVersion: 1,
    sha256: "51d590a381a19ee162a13ccdd55b47b3baf37d3372ebd2a6e7c14fa19780bf2e",
    path: "generated/CodebaseRegisterRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CreatePullRequestInput/v1",
    schemaVersion: 1,
    sha256: "55873424bc47a8bd87d409ef294271c8fd81d1b7a6111b92bb8501f782dba79c",
    path: "generated/CreatePullRequestInput.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/DaemonHelloResult/v1",
    schemaVersion: 1,
    sha256: "238a2a706c495f67986ba079f6e6abe15ba80c33ec56f19de3992ac15778470b",
    path: "generated/DaemonHelloResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/DaemonNegotiationRequest/v1",
    schemaVersion: 1,
    sha256: "735acf914eb78c3c4a6b19952226f2c99b387209ef52271f7d51e6737eecf271",
    path: "generated/DaemonNegotiationRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/DaemonNegotiationResult/v1",
    schemaVersion: 1,
    sha256: "00c16803d9abddc83f3fb299fab45f5985d9f504b69e8287d6d4d5fa8cee8c8b",
    path: "generated/DaemonNegotiationResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/DaemonRecoveryResult/v1",
    schemaVersion: 1,
    sha256: "8c4099c58b018a809e8708451e33ccdc4e24fa74fb65865d35953af9f3672e9a",
    path: "generated/DaemonRecoveryResult.v1.schema.json",
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
    schemaId: "heniek://contract/DoctorReport/v1",
    schemaVersion: 1,
    sha256: "1645c1a617331955c3a515bd3942e423e71e3fbc460093092fc149b0cee6e56c",
    path: "generated/DoctorReport.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionEvent/v1",
    schemaVersion: 1,
    sha256: "a6869c7f7081c5a272a36b834463080fe1fe92e6ef6717c705ad870023bc79ca",
    path: "generated/ExecutionEvent.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionRequest/v1",
    schemaVersion: 1,
    sha256: "0642730af967d4a595cf4855a738e975b8577f6e18c6c1cb4e75a08be0edb02e",
    path: "generated/ExecutionRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionRequest/v2",
    schemaVersion: 2,
    sha256: "14b1e641b2d47a74157b242916135d7ac82a3eb69d2604362a405bffe4f08530",
    path: "generated/ExecutionRequest.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionRequest/v3",
    schemaVersion: 3,
    sha256: "92153ef4e245c38a292945edcd361b21060c595c91a1d783f33c55d3f1507246",
    path: "generated/ExecutionRequest.v3.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionResult/v1",
    schemaVersion: 1,
    sha256: "7aabaff4e3b8450036a27c1c25ac299cd5d22a03b5feb7c2ea05657513ac7942",
    path: "generated/ExecutionResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionResult/v2",
    schemaVersion: 2,
    sha256: "1a16ecaf34af5f4f8d3c3c58fa250fdd6a4dd2a26ea0bef5213d160f45174d68",
    path: "generated/ExecutionResult.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/ExternalStageResult/v1",
    schemaVersion: 1,
    sha256: "01bed7cf9a7ddd68324d223ee40f1a84ac8c912735df90905a958045363a3fba",
    path: "generated/ExternalStageResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/InstructionDiagnostic/v1",
    schemaVersion: 1,
    sha256: "8ec3850c705343e34ddb27a7eff133fc68d1ef249f358e5b63cb43db967768e6",
    path: "generated/InstructionDiagnostic.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/InstructionSnapshot/v1",
    schemaVersion: 1,
    sha256: "4b2a91b69795c4878b770670cff4cbff166617107ecefc57a6dc83881fd2ad42",
    path: "generated/InstructionSnapshot.v1.schema.json",
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
    schemaId: "heniek://contract/InteractionAnswerSet/v1",
    schemaVersion: 1,
    sha256: "4507e20f81c05c301a8a383dc48f87c56816408c9b8f901285c927cc1e21064b",
    path: "generated/InteractionAnswerSet.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PendingInteraction/v1",
    schemaVersion: 1,
    sha256: "18105638d2b12bdaeddd18b51e23d60b5e60ebdc9d0fe1f59dd831a86364ced9",
    path: "generated/PendingInteraction.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PendingInteraction/v2",
    schemaVersion: 2,
    sha256: "8f134cc3ad8f7b13d2912bca9d7285eb8d60d03bdd004b8e68a9e588a63bf3d9",
    path: "generated/PendingInteraction.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/ProfileConfiguration/v1",
    schemaVersion: 1,
    sha256: "dce7d5cd0d6eba0941613e3727dc086b8c7cdbf0cc7268e609c9ac3ac0ae0ac4",
    path: "generated/ProfileConfiguration.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PullRequest/v1",
    schemaVersion: 1,
    sha256: "07c6c0fead0ade0271932b7f60262d84644c3097fed4462ca374f9a22496c0ef",
    path: "generated/PullRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RegisteredCodebase/v1",
    schemaVersion: 1,
    sha256: "46aaf927a7b496d3da5b4c438c2f49ab7c6638363384cb0d6aca61fa0258b10f",
    path: "generated/RegisteredCodebase.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ResolvedConfiguration/v1",
    schemaVersion: 1,
    sha256: "ab0ae9b99bb0e98c56e93665a92f049d86c3f43949f02764b0501b45e563fbd1",
    path: "generated/ResolvedConfiguration.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ResolvedProfile/v1",
    schemaVersion: 1,
    sha256: "716c3c94cb8b50448e441086633aba0fd117952fb92ab11584ebbcf4bf0d3056",
    path: "generated/ResolvedProfile.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RpcCancelRequest/v1",
    schemaVersion: 1,
    sha256: "803ac5814746c84f6bdd37e4208da4f20ca57d60c5d17bc250d9dd160fe5a64b",
    path: "generated/RpcCancelRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RpcCancelResult/v1",
    schemaVersion: 1,
    sha256: "1d6d60cb7480d919ef37faf601e7507b3d93cc12f8bf525489bd7c1e6864e967",
    path: "generated/RpcCancelResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/Run/v1",
    schemaVersion: 1,
    sha256: "be0a661b93dee4b9f8a0c9b4e642864ebf99e94cbc4d06b3790b0a01bf2dc601",
    path: "generated/Run.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/Run/v2",
    schemaVersion: 2,
    sha256: "d25ab256d3f066f6f6c98c8484b748522ce297e7fea3892c4510728e7cca1732",
    path: "generated/Run.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/RunRecoveryClassification/v1",
    schemaVersion: 1,
    sha256: "bd4fe19884b2fcf1f6377f202def77a6cf7fce170349ee186bfdc7bf504b077c",
    path: "generated/RunRecoveryClassification.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RuntimeCompatibilityReport/v1",
    schemaVersion: 1,
    sha256: "9cb943be798d7b0ff377da4f2127890cf7730f5f337e37760c3861a5cf788247",
    path: "generated/RuntimeCompatibilityReport.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RuntimeIdentity/v1",
    schemaVersion: 1,
    sha256: "ce7aec12b69118ab3dcd3010eb9c9b90b8ae7d9d0511264e0af6b8a7df7b30a2",
    path: "generated/RuntimeIdentity.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RuntimeInventory/v1",
    schemaVersion: 1,
    sha256: "496a2e872289f10186114835ee8b7c2e4bf570ee1d44d728399377577f3037af",
    path: "generated/RuntimeInventory.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RuntimeMutationResult/v1",
    schemaVersion: 1,
    sha256: "2bdfc6eba6e46da51ad8b1bd88e6aceaad031090e2963a3886123d03914ef840",
    path: "generated/RuntimeMutationResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunMutationResult/v1",
    schemaVersion: 1,
    sha256: "7491e0d1842751707d3658b7c71c058f1d2a6b1194d8c6752511b8293f1c9e3b",
    path: "generated/StageRunMutationResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunResult/v1",
    schemaVersion: 1,
    sha256: "8f0faffeabe166f355b7033e9a45b6cf2bae829d1ab64ab10f086fce501fc8fa",
    path: "generated/StageRunResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunStatusResult/v1",
    schemaVersion: 1,
    sha256: "69c0bd03d97d24dab4ee7b8b552b224ec23ddc5536db25e08bdd70b82a88fc79",
    path: "generated/StageRunStatusResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageStartResult/v1",
    schemaVersion: 1,
    sha256: "35776620780b4a150ab249801125096c4edfd9bfb8713c5c3e57e3d41c616341",
    path: "generated/StageStartResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskContext/v1",
    schemaVersion: 1,
    sha256: "bba19a9bb7a0647c6e80babe821b020650f4fb702fcffb629a1ac57ff56eaa6a",
    path: "generated/TaskContext.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/WorkspaceConfiguration/v1",
    schemaVersion: 1,
    sha256: "53f2eef07832e93707729cd0ee79be2a9e9b17ee9fc85a4bf1e95c2da1bf3710",
    path: "generated/WorkspaceConfiguration.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/WorkspaceProvisioningManifest/v1",
    schemaVersion: 1,
    sha256: "0d69e2a405e4c7b65cb9da6da833c502fdb83b21f102e212b86abcb43e742b54",
    path: "generated/WorkspaceProvisioningManifest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/WorkspaceSynchronizationResult/v1",
    schemaVersion: 1,
    sha256: "2fe27587400747272e5acf288c4ab05d0495bf216c7e3fdf1d97e0ef1278abbf",
    path: "generated/WorkspaceSynchronizationResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/WorkspaceWriterLease/v1",
    schemaVersion: 1,
    sha256: "75b0e5e7d04c02d73266ce663bd691d3a9d26d017e459faaee50a7d31e05c18d",
    path: "generated/WorkspaceWriterLease.v1.schema.json",
  },
];

describe("packages/contracts generated manifest is unchanged (AC4)", () => {
  it("manifest.json lists exactly the 61 known schemas with their recorded sha256", async () => {
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
