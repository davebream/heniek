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
 * Q039 deliberately resets the unpublished bootstrap `TaskContext/v1`
 * contract from a flat summary to the complete snapshot/revision/hierarchy
 * context and adds five supporting schemas. The issue and implementation plan
 * explicitly authorize this alpha break. `@heniek/contracts` remains private,
 * and the only pre-Q039 consumer was the bundled conformance fake updated in
 * the same change; there are no persisted TaskContext payloads to migrate.
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
 *
 * Q017 raises the count 61 → 63 by adding structured execution events and
 * normalized result usage/diff fields. Existing contracts remain byte-identical.
 *
 * Q020 raises the count 66 → 76 by pure addition for durable interaction,
 * answer, resume, inbox, and v2 daemon result contracts. All 66 prior hashes remain
 * byte-identical; the new event and result reference the standalone telemetry
 * schema instead of duplicating its definition.
 *
 * Q023 raises the count 89 → 103 by pure addition: the thirteen
 * `ParentSession*`/`NativeStage*` contracts of the native Claude bridge, plus
 * `StageStartResult/v3` for the single admission door that routes by the
 * resolved profile's `executionMode`. All 89 prior hashes are byte-identical
 * — `git diff` on `generated/manifest.json` for that change is 84 insertions
 * and zero deletions, and no existing `*.schema.json` file was rewritten.
 *
 * Three properties of the new family are worth recording, because each is a
 * choice that could have forced a breaking change and deliberately did not:
 *
 * 1. `RunStatus` was **not** extended. `waiting_for_parent_session` has been
 *    a declared-but-unreachable member since the vocabulary was written, so
 *    the state the bridge finally produces was already legal in all thirteen
 *    wire schemas that embed `RunStatus.schema` — no digest moved to reach it.
 * 2. `ExecutionStatus` was **not** extended either. Adding a value to a
 *    `defineStates` vocabulary reorders `values`, which reorders the `anyOf`
 *    of its schema, which changes the sha256 of every schema embedding it —
 *    `ExecutionResult/v2..v5`, `ExecutionAttempt/v1`, `ExecutionEvent/v3` and
 *    the daemon results carrying those. `waiting_for_parent_session` stays
 *    out of it because it is Heniek-owned and never backend-reported.
 * 3. The question contracts are reused, not re-minted. A native `needs_input`
 *    crosses as the same `PendingInteraction/v2` an external backend raises,
 *    and is answered through the same `InteractionAnswerSubmission/v2`.
 *
 * Q023 then raises the count 103 → 106 for a defect found while implementing
 * it, again by pure addition: `SchedulingDecision/v2` plus the two daemon
 * results that carry it, `StageRunStatusResult/v4` and `StageRunResult/v3`.
 *
 * `SchedulingDecision/v1` omits four kinds the scheduler has always written —
 * `attempt_succeeded`, `attempt_cancelled`, `attempt_recovery_required` and
 * `user_choice`. Nothing caught it, because `recordDecision` typed `kind` as
 * a bare `string`, `scheduling_decision.kind` carries no CHECK, and outgoing
 * results are never validated against their own published schema. The
 * consequence was live: a run that took a fallback, was cancelled by the
 * user, or ended in recovery could be reported through `run.status.v3` or
 * `run.result.v2` as a payload that fails those methods' own pinned schemas.
 *
 * Widening V1 in place would have been the smaller diff, and was rejected:
 * the in-place route requires proof that the schema's consumer set is empty,
 * which is exactly what is *not* true of a shipped daemon result. So V1 stays
 * frozen and incomplete, V2 is complete, and V1 remains selectable through
 * `daemon.negotiate` for any client pinned to it.
 *
 * The durable fix is not this schema — it is that `recordDecision` now takes
 * `SchedulingDecisionKind` instead of `string`, so the next omission is a
 * compile error rather than a wire-format lie.
 *
 * Q025 raises the count 109 → 118 by pure addition: pipeline-runtime contracts
 * for stage snapshots, attempts, transitions, scheduler decisions/intents/
 * observations/plans, and terminal outcomes. All 109 prior hashes remain
 * byte-identical.
 *
 * Q026 raises the count 118 → 125 by pure addition: stage-runner attempt,
 * result, evidence, failure, output-binding, cleanup, and validation-report
 * contracts. All 118 prior hashes remain byte-identical.
 *
 * Q027 raises the count 125 → 142 by pure addition: approval/integration/
 * verify/publish operation contracts, runner attempt/result/failure v2, and
 * external-observation/reconciliation traces. All 125 prior hashes remain
 * byte-identical — Q026 StageRunner v1 digests are unchanged.
 *
 * Q028 raises the count 142 → 152 by pure addition: PipelineFailure/
 * FailureSignature/RetryDirective/RecoveryDecision v1 and scheduler
 * observation/intent/attempt/decision/input/plan v2. All 142 prior hashes
 * remain byte-identical.
 *
 * Q029 raises the count 152 → 157 by pure addition: PipelineExecutionSegment/
 * FusionDecision/ContinuationCapsule/IncomingVerification v1 and
 * ExecutionResumeRequest v2. All 152 prior hashes remain byte-identical.
 *
 * Q024 raises the count 106 → 109 by pure addition again: `PipelineDefinition/v1`
 * (the authored YAML document), `PipelineGraph/v1` (its normalized form), and
 * `PipelineValidationResult/v1` (graph plus diagnostics). All 106 prior hashes
 * are byte-identical — 18 manifest insertions, zero deletions, no existing
 * `*.schema.json` rewritten.
 *
 * Q032 raises the count 169 → 181 by pure addition: PipelineValidate/Run/Attach
 * request+result, run snapshot, definition source, invocation override request,
 * applied override, attached stage definition, attachment lifecycle.
 *
 * One choice there is worth the same kind of note as the three above. A
 * pipeline diagnostic carries a `suggestion` the configuration family's
 * diagnostic does not. Adding the field to the inlined `Diagnostic` in
 * `contracts/src/configuration/schemas.ts` would have been the smaller diff
 * and was rejected: that object is embedded in `ApplicationHome/v1`,
 * `ResolvedConfiguration/v1`, `ResolvedProfile/v1` and `/v2`, so one new
 * optional field would move four published digests to serve one new consumer.
 * The pipeline family inlines its own copy instead.
 *
 * Q035 raises the count 185 → 189 by pure addition: V2 Codebase configuration
 * and resolved snapshots add structured setup dependencies/timeouts, while
 * composite provisioning and effective-instruction reports receive new V1
 * contracts. Every previously pinned schema digest remains byte-identical.
 *
 * Capability landing raises the count 190 → 198 by pure addition:
 * CapabilityDelta/Landing/ResolutionBlocker v1, StageStartRequest/v3,
 * StageRunResult/v4, ExecutionRequest/v5, NativeStageDispatch/v2, and
 * NativeStagePollResult/v2. Every previously pinned digest stays byte-identical.
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
    schemaId: "heniek://contract/ApprovalContinuation/v1",
    schemaVersion: 1,
    sha256: "a6e86649cd02983cb391bbca2e018ac0ff71f45edc86ac5814dadea3d11d4417",
    path: "generated/ApprovalContinuation.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ApprovalDecision/v1",
    schemaVersion: 1,
    sha256: "90fd923b2721b123c877d93dea78218272c1724a120ccd6f0bc1589e6643d5c8",
    path: "generated/ApprovalDecision.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ApprovalRequest/v1",
    schemaVersion: 1,
    sha256: "2f7b0541fa9267290e5a4fde7945340e37aa267288f54c64625fb9e224bfa9e3",
    path: "generated/ApprovalRequest.v1.schema.json",
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
    schemaId: "heniek://contract/CapabilityDelta/v1",
    schemaVersion: 1,
    sha256: "2097f85b0bd2bfe3da37ad3175c2df2d086e90b031df6caadc450a72dd8e9c16",
    path: "generated/CapabilityDelta.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CapabilityLanding/v1",
    schemaVersion: 1,
    sha256: "51c10a4f40bbfeb4b3973c41e658311bb768cafeeb267e02c16ee438c39b7282",
    path: "generated/CapabilityLanding.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CapabilityResolutionBlocker/v1",
    schemaVersion: 1,
    sha256: "64691abfed4ca234b418225f7a58396299c49dfc0030925bbab0b113e4457a8d",
    path: "generated/CapabilityResolutionBlocker.v1.schema.json",
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
    schemaId: "heniek://contract/CodebaseConfiguration/v1",
    schemaVersion: 1,
    sha256: "60bb6bb0518723af3f0f5f5c7b9f700ecdbef807272773ebb4e14f28c14f15d3",
    path: "generated/CodebaseConfiguration.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CodebaseConfiguration/v2",
    schemaVersion: 2,
    sha256: "e0df43d7215ca762f81cc04b9c6c1c95d889cf2382b28e7d6c2d051bc1291a48",
    path: "generated/CodebaseConfiguration.v2.schema.json",
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
    schemaId: "heniek://contract/CodebaseOnboardApplyRequest/v1",
    schemaVersion: 1,
    sha256: "f6b33d3bf7b30bf841a55c6ddb5da275e1b55ef0b50a6558437c2130d5c2eebd",
    path: "generated/CodebaseOnboardApplyRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CodebaseOnboardApplyResult/v1",
    schemaVersion: 1,
    sha256: "33083526dd9864eb2cbe4338bfe3e460d2390c7de12480a070a41479f898606a",
    path: "generated/CodebaseOnboardApplyResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CodebaseOnboardingProposal/v1",
    schemaVersion: 1,
    sha256: "1105291b5971a6f353d6f4f45121c63fa8ddfcf7280db7fc274ab20ef15023c7",
    path: "generated/CodebaseOnboardingProposal.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CodebaseOnboardProposeRequest/v1",
    schemaVersion: 1,
    sha256: "00aa6490cd316c30ec445212c14bdd6158c75b860907e5dce40a8bae67a75e5c",
    path: "generated/CodebaseOnboardProposeRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CodebaseOnboardProposeResult/v1",
    schemaVersion: 1,
    sha256: "a9e39c12bb7ca60bf6b1c7f758ea5067ca1d131d6dbd0274bbb6666399a85af9",
    path: "generated/CodebaseOnboardProposeResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CodebaseRegisterRequest/v1",
    schemaVersion: 1,
    sha256: "51d590a381a19ee162a13ccdd55b47b3baf37d3372ebd2a6e7c14fa19780bf2e",
    path: "generated/CodebaseRegisterRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CombinedVerificationReport/v1",
    schemaVersion: 1,
    sha256: "c37cbc5df1c4397ac2fe623440c6ce65bce00057b7fcd43c065fee8ce7f82354",
    path: "generated/CombinedVerificationReport.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/CompositeWorkspaceProvisioningManifest/v1",
    schemaVersion: 1,
    sha256: "5ffaece2623950e0a315a99533fdff33c260d9fe8f1ceaf02154b86237c54826",
    path: "generated/CompositeWorkspaceProvisioningManifest.v1.schema.json",
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
    schemaId: "heniek://contract/DoctorReport/v2",
    schemaVersion: 2,
    sha256: "f0628f4e37b38cfd03042960f72927b0d36234a9a27df3f8222191ce79b93b11",
    path: "generated/DoctorReport.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/EffectiveInstructionReport/v1",
    schemaVersion: 1,
    sha256: "c5471a64878071057e08b3c3f8e40ad6bcf02f9078389fcb39b6fdb167b2a368",
    path: "generated/EffectiveInstructionReport.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/EpicRepositoryBranch/v1",
    schemaVersion: 1,
    sha256: "d029db045c767de7a30ac779e2a834badef534dcf4611d9328d296ab9488289d",
    path: "generated/EpicRepositoryBranch.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionAttempt/v1",
    schemaVersion: 1,
    sha256: "cbe5804f47363fa784c1a2ff20433a6dfc530c18dc12b4342712af789a227326",
    path: "generated/ExecutionAttempt.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionEvent/v1",
    schemaVersion: 1,
    sha256: "a6869c7f7081c5a272a36b834463080fe1fe92e6ef6717c705ad870023bc79ca",
    path: "generated/ExecutionEvent.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionEvent/v2",
    schemaVersion: 2,
    sha256: "88cdadffd6b9c04a32411c66ae376fe8adfe411d88f7c9f749bef69571de8fe7",
    path: "generated/ExecutionEvent.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionEvent/v3",
    schemaVersion: 3,
    sha256: "b655478dec94642c6746fc061f475c296a03db91a1065bc7d6c6f174a0cf2d08",
    path: "generated/ExecutionEvent.v3.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionFailure/v1",
    schemaVersion: 1,
    sha256: "f507e9917e0b5c6b0028fa0d22517aa39be00406596ddf5be9716dd43b75d889",
    path: "generated/ExecutionFailure.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionPermissionEnvelope/v1",
    schemaVersion: 1,
    sha256: "5d822fdbdc8cf6c8daca105befadd4017f7743c63f430fdc831dbf97660d6d97",
    path: "generated/ExecutionPermissionEnvelope.v1.schema.json",
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
    schemaId: "heniek://contract/ExecutionRequest/v4",
    schemaVersion: 4,
    sha256: "843e3e31dfda8cc621eb7a537e84e9b73b4d0ddb93a02eca4da979f54d15dc46",
    path: "generated/ExecutionRequest.v4.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionRequest/v5",
    schemaVersion: 5,
    sha256: "21eaec3cc6dd54eec0ac05f367cf52a73bae0fccc10d6f0d3d701b5bb1bb108c",
    path: "generated/ExecutionRequest.v5.schema.json",
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
    schemaId: "heniek://contract/ExecutionResult/v3",
    schemaVersion: 3,
    sha256: "7f6227929dc19b70dcdfcc48fa02be162c06c5d2a0960bceb72cb24e761a33b1",
    path: "generated/ExecutionResult.v3.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionResult/v4",
    schemaVersion: 4,
    sha256: "95fb520c52f22d554a1d05d959297a89555ab08e8abefefe5d600791a587be93",
    path: "generated/ExecutionResult.v4.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionResult/v5",
    schemaVersion: 5,
    sha256: "d571cb7f7e270456a07dafd43a931737393d315610248d319d4f7782ad0c95f5",
    path: "generated/ExecutionResult.v5.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionResumeRequest/v1",
    schemaVersion: 1,
    sha256: "32973343072198df77494c995a00632ed655c80cfa44b557c4df3c49783538ab",
    path: "generated/ExecutionResumeRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionResumeRequest/v2",
    schemaVersion: 2,
    sha256: "ca164d5d59ab47a8555dcd16b08967b815d3c4e7113f933466a4840a3648fa6b",
    path: "generated/ExecutionResumeRequest.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionTaskRevision/v1",
    schemaVersion: 1,
    sha256: "dfccebc9e4c638c6f895684891c6c39e2fb214d1f7b3956b208caa9e67f9659a",
    path: "generated/ExecutionTaskRevision.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ExecutionTelemetry/v1",
    schemaVersion: 1,
    sha256: "ebf92b2b848a42cedb66191b4fe8b00a9aaea6d32182e1409f5f0b8123f0a306",
    path: "generated/ExecutionTelemetry.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ExternalStageResult/v1",
    schemaVersion: 1,
    sha256: "01bed7cf9a7ddd68324d223ee40f1a84ac8c912735df90905a958045363a3fba",
    path: "generated/ExternalStageResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/FinalVerificationReport/v1",
    schemaVersion: 1,
    sha256: "59a01b6eed094da71a80a23f6743975af4682c1247a966c26f5c9a368b437ae1",
    path: "generated/FinalVerificationReport.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/FindingSnapshot/v1",
    schemaVersion: 1,
    sha256: "dbaa851a4e27eb4b34e65e015bee7bdd12d2a51a8a34cdcbca13b0e551fccaa1",
    path: "generated/FindingSnapshot.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/HiddenDependencyFinding/v1",
    schemaVersion: 1,
    sha256: "ee0d7e3cee64673e15549c58cfa77c5f1855e1abcb40d981453167764b83261d",
    path: "generated/HiddenDependencyFinding.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/HiddenDependencyReplan/v1",
    schemaVersion: 1,
    sha256: "191162792585059b3aea1bebb24057dc404ca7a1d2fb3fc23553ff77f5ce7dba",
    path: "generated/HiddenDependencyReplan.v1.schema.json",
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
    schemaId: "heniek://contract/IntegrationRequest/v1",
    schemaVersion: 1,
    sha256: "fa44040209b47486d149df11468ce05c65f0bbac48c82505182f60814a1c473e",
    path: "generated/IntegrationRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/IntegrationResult/v1",
    schemaVersion: 1,
    sha256: "9e37baf5c91e9474e6c318a801745193555b3487932c9215823de7dd8da2e873",
    path: "generated/IntegrationResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/Interaction/v1",
    schemaVersion: 1,
    sha256: "3f1ceff9662dac675b46bb362e61068934b845ca650957698b3c2c577f3c171a",
    path: "generated/Interaction.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/Interaction/v2",
    schemaVersion: 2,
    sha256: "b3747e6f817f5ba8c30714ec96154a928a2c89e495996d9ed061663137406c50",
    path: "generated/Interaction.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/InteractionAnswer/v1",
    schemaVersion: 1,
    sha256: "8d290caa830edd351698906634f6748080e6c682b776b0ba6cbda39e0bbc5a3d",
    path: "generated/InteractionAnswer.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/InteractionAnswer/v2",
    schemaVersion: 2,
    sha256: "f6237959267166f29fcc2a2b86bd22bd80254792541aeed0942b462462d3d7c4",
    path: "generated/InteractionAnswer.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/InteractionAnswerSet/v1",
    schemaVersion: 1,
    sha256: "4507e20f81c05c301a8a383dc48f87c56816408c9b8f901285c927cc1e21064b",
    path: "generated/InteractionAnswerSet.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/InteractionAnswerSubmission/v2",
    schemaVersion: 2,
    sha256: "f0ef40120c5e2f3ee400cf55e7f98cd7862345a7c9372316bc7ce80f5a0e4291",
    path: "generated/InteractionAnswerSubmission.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/InteractionInboxResult/v1",
    schemaVersion: 1,
    sha256: "5df66ed00d0e1f61793299773df14d61885013e5d234bcb533f69d16bac04428",
    path: "generated/InteractionInboxResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/NativeStageAttempt/v1",
    schemaVersion: 1,
    sha256: "880390d4691d583ccabbc6acfd8afd2946d440ee0f68412ba390c20173f0e8b3",
    path: "generated/NativeStageAttempt.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/NativeStageDispatch/v1",
    schemaVersion: 1,
    sha256: "db90744ffaae8e6bbf66ccac8ad19b415f0528d6a3da717179f1660e24d1f19f",
    path: "generated/NativeStageDispatch.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/NativeStageDispatch/v2",
    schemaVersion: 2,
    sha256: "99a3e6f636190744c6295bd36855aa1a65a2e99182d37a6e9d4a38ceb22bfd37",
    path: "generated/NativeStageDispatch.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/NativeStagePollRequest/v1",
    schemaVersion: 1,
    sha256: "064ea588ce653f32bbe150e87a903ff002ff27eeb275047c9b1f6978f564fb53",
    path: "generated/NativeStagePollRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/NativeStagePollResult/v1",
    schemaVersion: 1,
    sha256: "0e87c1f1fe5605faf0a1e1abf866c5771c3874234156bb11383e015019988e15",
    path: "generated/NativeStagePollResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/NativeStagePollResult/v2",
    schemaVersion: 2,
    sha256: "a34c271e8d80966f0f9bc150edaa895c7ae4ca60bd4e411de1ef708bff09925b",
    path: "generated/NativeStagePollResult.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/NativeStageQuestionRequest/v1",
    schemaVersion: 1,
    sha256: "d399c78a652f319453744d2a3ef77a6507838fdfaaf0bc8f23bcab416c1196af",
    path: "generated/NativeStageQuestionRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/NativeStageQuestionResult/v1",
    schemaVersion: 1,
    sha256: "04594a8c6786a0b580bcbe23bd5d961cd472ed1e7b05caff3c21f6474748b3be",
    path: "generated/NativeStageQuestionResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/NativeStageStatusResult/v1",
    schemaVersion: 1,
    sha256: "18900c67f5cc173368e22f630e8f468ea7d98b834ad1997bd6ed8f8ce22bfa82",
    path: "generated/NativeStageStatusResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/NativeStageSubmitRequest/v1",
    schemaVersion: 1,
    sha256: "a7b3c52a475804355b684cdb21aee58956402e46cacacf83ec8363afeb387eb8",
    path: "generated/NativeStageSubmitRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/NativeStageSubmitResult/v1",
    schemaVersion: 1,
    sha256: "1acbf78f9cd4d1db91efab9ebef1f36afbba99609e096ce82d5fa315031483c5",
    path: "generated/NativeStageSubmitResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ParentHandoff/v1",
    schemaVersion: 1,
    sha256: "3f737e89d8f16f80d3726b49593f53ef2ca96914cdff6dcb6571f75f6419bf3d",
    path: "generated/ParentHandoff.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ParentSessionAttachment/v1",
    schemaVersion: 1,
    sha256: "bdfc12500ea76159d46d9da097dc41569cbc0004df2dc55daa58088bcb2fc555",
    path: "generated/ParentSessionAttachment.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ParentSessionAttachRequest/v1",
    schemaVersion: 1,
    sha256: "0e155c67065c6d053e6ff80ab57f0ae7a0f865e6e0ddf0d684407a7b3451e4a6",
    path: "generated/ParentSessionAttachRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ParentSessionDetachRequest/v1",
    schemaVersion: 1,
    sha256: "b979417cde98955b6241465b9ebad0c720226b9ba2cc1b2e2bd5d506c347a0ed",
    path: "generated/ParentSessionDetachRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ParentSessionDetachResult/v1",
    schemaVersion: 1,
    sha256: "a945c521166ae607a61052dcc1b3d93824dc327d2badf18546fea108dc1f90d1",
    path: "generated/ParentSessionDetachResult.v1.schema.json",
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
    schemaId: "heniek://contract/PipelineAppliedOverride/v1",
    schemaVersion: 1,
    sha256: "261b13f0cf24282a4934396728788c1b6f9c2b43acfb7b0983aaacd4073ed8a6",
    path: "generated/PipelineAppliedOverride.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineAttachedStageDefinition/v1",
    schemaVersion: 1,
    sha256: "bbb70b1464208d4c65393c992bd35fd0368fea05245946c93915fddf5006128c",
    path: "generated/PipelineAttachedStageDefinition.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineAttachmentLifecycle/v1",
    schemaVersion: 1,
    sha256: "9b151c90c0e4de00c52476e7def8d85e235496fd9685469d4847bab31bcf4dca",
    path: "generated/PipelineAttachmentLifecycle.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineAttachRequest/v1",
    schemaVersion: 1,
    sha256: "672bb2d44dff11bd497cbd6e4828521a11a8024eebc2564b2772c39abdc58d8b",
    path: "generated/PipelineAttachRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineAttachResult/v1",
    schemaVersion: 1,
    sha256: "c2b7e4ef3d5a7b2cca929e307bb9b1d5a179f225310774bce0a5f7f966afd5a5",
    path: "generated/PipelineAttachResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineContinuationCapsule/v1",
    schemaVersion: 1,
    sha256: "dc88fa4e396c08fb55c80c755b6d07c52157b720e818a810d4df7d77db1843fc",
    path: "generated/PipelineContinuationCapsule.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineDefinition/v1",
    schemaVersion: 1,
    sha256: "8f13880f0509468a85ed5b7e8701e8bdddf00fae640e8c7b3fc4f24b5dec14a1",
    path: "generated/PipelineDefinition.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineDefinitionSource/v1",
    schemaVersion: 1,
    sha256: "c5f8f22062fce80778d8bd9e13113ca25242335547d4d7968e32605c962d7240",
    path: "generated/PipelineDefinitionSource.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineExecutionSegment/v1",
    schemaVersion: 1,
    sha256: "a7a579514bd322db32d324582242f933f636a3d0d5c73b2818b93d19131326cc",
    path: "generated/PipelineExecutionSegment.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineFailure/v1",
    schemaVersion: 1,
    sha256: "a80495ff9ae4c25ecb155a1cdb1bba1e098436864acfe263b00854583d524021",
    path: "generated/PipelineFailure.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineFailureSignature/v1",
    schemaVersion: 1,
    sha256: "35eb6b4ee34a965c4d0046d8c53c7759cfa7ddb455c5ccb3fcb4ba88aff216ba",
    path: "generated/PipelineFailureSignature.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineFusionDecision/v1",
    schemaVersion: 1,
    sha256: "bfd39b491aaad92db1423a8ab1c48067cd239b7c957d13f591ff5caf09038c3f",
    path: "generated/PipelineFusionDecision.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineGraph/v1",
    schemaVersion: 1,
    sha256: "16307f658328ededa1998ef22706004b4bce06247d6775df0361616dd7dfa3b1",
    path: "generated/PipelineGraph.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineIncomingVerification/v1",
    schemaVersion: 1,
    sha256: "2b7cdf7ae891a18b603946d5b834e7bb1f7e87667670a4706c32820803cc3e1e",
    path: "generated/PipelineIncomingVerification.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineInvocationOverrideRequest/v1",
    schemaVersion: 1,
    sha256: "887dd607a23d3789d3a814cf99272a7d78c26e184113d914099c3be07c6a42b3",
    path: "generated/PipelineInvocationOverrideRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineRecoveryDecision/v1",
    schemaVersion: 1,
    sha256: "734b2e94ec44e8823002efcff3782474534599da3491bec4a509c609c26adf89",
    path: "generated/PipelineRecoveryDecision.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineRetryDirective/v1",
    schemaVersion: 1,
    sha256: "f89c54e2fb379de9b4b94940da9e16779c6898ba5f6c2a43574ccf345045ab11",
    path: "generated/PipelineRetryDirective.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineRunRequest/v1",
    schemaVersion: 1,
    sha256: "60a16247059d2b4af15958c93e5496681200b8b98d36a804bfc71689677c6107",
    path: "generated/PipelineRunRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineRunResult/v1",
    schemaVersion: 1,
    sha256: "084191f330472f113e55bbc71ae9c75b7f961e1ae3b72993d32f0121a32817e1",
    path: "generated/PipelineRunResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineRunSnapshot/v1",
    schemaVersion: 1,
    sha256: "9db8b43fa4b873b93001968a53cfe5298a97c483e9df0fbc5781e4b98f2134d4",
    path: "generated/PipelineRunSnapshot.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineSchedulerDecision/v1",
    schemaVersion: 1,
    sha256: "1b50dfd40f42c7054409bdb7bbd40ce6faf467988f8bfaf52d9db9442ef54753",
    path: "generated/PipelineSchedulerDecision.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineSchedulerDecision/v2",
    schemaVersion: 2,
    sha256: "e314c36a414df8283cbc168a96cbd6cef9db7402f0b43c6b240784f1a8acfabc",
    path: "generated/PipelineSchedulerDecision.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineSchedulerInput/v1",
    schemaVersion: 1,
    sha256: "4b46ef59bdc4d6c2b7bc76acfa113ed71115aaa5f6b7d9f8c24be05a5acaf865",
    path: "generated/PipelineSchedulerInput.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineSchedulerInput/v2",
    schemaVersion: 2,
    sha256: "38df143f6f00e027eea410086b6914b3c338b1cea977649f43c5e88ea0670a41",
    path: "generated/PipelineSchedulerInput.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineSchedulerIntent/v1",
    schemaVersion: 1,
    sha256: "07ebcc752e4ba5c7d44eebe84da7a46bc43cdb4ae9336ef8f9ad7dc467f03a4d",
    path: "generated/PipelineSchedulerIntent.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineSchedulerIntent/v2",
    schemaVersion: 2,
    sha256: "018a79bf8a8c51a0e4bca9d6cd9959c68d71d8b9dcd9882cb70c745123109a23",
    path: "generated/PipelineSchedulerIntent.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineSchedulerObservation/v1",
    schemaVersion: 1,
    sha256: "664c190560779b912f810f784a45b4c6291aca1fe6ef18007d0765be3a3b6675",
    path: "generated/PipelineSchedulerObservation.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineSchedulerObservation/v2",
    schemaVersion: 2,
    sha256: "d2315234aa6db5a354b820e223a898f71e1f6f6e9950e41c8406efc1a4f54a8d",
    path: "generated/PipelineSchedulerObservation.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineSchedulerPlan/v1",
    schemaVersion: 1,
    sha256: "a7eed9ad580fb492f35aa18b811c1f46a57c76cb4d5cd0da7f2519d6b7dd2e98",
    path: "generated/PipelineSchedulerPlan.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineSchedulerPlan/v2",
    schemaVersion: 2,
    sha256: "9403afc78833d4bd936e0d9f4702f637458b2134d73f9dea2aaf018532fdc4a4",
    path: "generated/PipelineSchedulerPlan.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineScheduleTerminal/v1",
    schemaVersion: 1,
    sha256: "9e344dbdc3475ada6911e473a3763c1a6406092c23faff511c91e6cff19a9dcc",
    path: "generated/PipelineScheduleTerminal.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineStageAttempt/v1",
    schemaVersion: 1,
    sha256: "761582f3ecc96d022e039a137af1b00f7df797ee2236d7bc97ed8170c1cbe842",
    path: "generated/PipelineStageAttempt.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineStageAttempt/v2",
    schemaVersion: 2,
    sha256: "569849c2c677fca25dcdb43e59b1aaaf9b57f29349512f4a666707915797b87f",
    path: "generated/PipelineStageAttempt.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineStageSnapshot/v1",
    schemaVersion: 1,
    sha256: "ac1444c807a46c5a8666ab0551c8e7799ed79ddcecda7f5bc485cd6eaa227deb",
    path: "generated/PipelineStageSnapshot.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineStageTransition/v1",
    schemaVersion: 1,
    sha256: "7ded13132b1385e5ffed72062ae9e5959966b0039dbfb76262eb9a015e3fd768",
    path: "generated/PipelineStageTransition.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineValidateRequest/v1",
    schemaVersion: 1,
    sha256: "dfb20f9ef646bc242a05c4e8094376d9f5fe60cb35a49f695a35c89aa1a208be",
    path: "generated/PipelineValidateRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineValidateResult/v1",
    schemaVersion: 1,
    sha256: "cc43b1eace8beb7509396232b797662871282cbf396da8c0b38561fc30ddd863",
    path: "generated/PipelineValidateResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PipelineValidationResult/v1",
    schemaVersion: 1,
    sha256: "19a3183a732618aa3db2cb37aabe40fd923fef52f487c20b3901a6131cf5d1d4",
    path: "generated/PipelineValidationResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ProfileConfiguration/v1",
    schemaVersion: 1,
    sha256: "dce7d5cd0d6eba0941613e3727dc086b8c7cdbf0cc7268e609c9ac3ac0ae0ac4",
    path: "generated/ProfileConfiguration.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ProfileConfiguration/v2",
    schemaVersion: 2,
    sha256: "f58e57b3b1b8927d831f62160d247ef3c35df14d43b2b143db256518d317bcd5",
    path: "generated/ProfileConfiguration.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/PublishPullRequestSpec/v1",
    schemaVersion: 1,
    sha256: "ea267d5426db8ce3542a9f60dfa72d006c07e2dddaa703f8da0905657f9df08f",
    path: "generated/PublishPullRequestSpec.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PublishRequest/v1",
    schemaVersion: 1,
    sha256: "8f6516bfcc2da87468bfed8921f4965fedf30bc0fe9efbb5b1cbb73db70e4935",
    path: "generated/PublishRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/PublishResult/v1",
    schemaVersion: 1,
    sha256: "5564626cf3395a250c1f0750771896f64698df1a01bd1f8ab2d888903febb35d",
    path: "generated/PublishResult.v1.schema.json",
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
    schemaId: "heniek://contract/RepairReport/v1",
    schemaVersion: 1,
    sha256: "6f620d7736b89bc3851ea2de457f18daee572eb0dbdebff32a85239ceab1b87d",
    path: "generated/RepairReport.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RepositoryBasePin/v1",
    schemaVersion: 1,
    sha256: "d4cfe74e4c94af3bba8febd934597cd1f1284f390e5a94454448b0686d4c3983",
    path: "generated/RepositoryBasePin.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RepositoryProvisioningConfiguration/v1",
    schemaVersion: 1,
    sha256: "67b9a3201dc51625c2c98278ffe3d9a670889f8398951ff56fe9e36bcf512bd3",
    path: "generated/RepositoryProvisioningConfiguration.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RepositoryWorkspacePolicy/v1",
    schemaVersion: 1,
    sha256: "5cf03fd921bc9cece3ae33d6866b69db566784db22e547a5fd5e19e3c85cefe2",
    path: "generated/RepositoryWorkspacePolicy.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ResolvedCodebaseSnapshot/v1",
    schemaVersion: 1,
    sha256: "d6df95b17c9ffe21f793f28affa88dd2debbe81cc57028a4a29f4591c310d50e",
    path: "generated/ResolvedCodebaseSnapshot.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ResolvedCodebaseSnapshot/v2",
    schemaVersion: 2,
    sha256: "53cac4d5a02f5d18fc370d418381c3d90f09fd673ff089095fde3dd75bb99b65",
    path: "generated/ResolvedCodebaseSnapshot.v2.schema.json",
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
    schemaId: "heniek://contract/ResolvedProfile/v2",
    schemaVersion: 2,
    sha256: "9b0f456cb649977a6989e0fdd2f869f7bd7e8ca4ca07ab3c32ec9decab6c9d03",
    path: "generated/ResolvedProfile.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/ResolvedProfileChain/v1",
    schemaVersion: 1,
    sha256: "14bda7fb4b3eac7bf433be8221453835466208552c2f591780c91b289d214b74",
    path: "generated/ResolvedProfileChain.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ReviewFinding/v1",
    schemaVersion: 1,
    sha256: "1ee682a4a2881a110f48b0a9276dfe9d4074376f1ed56e0aa538d087fe188ee2",
    path: "generated/ReviewFinding.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/ReviewReport/v1",
    schemaVersion: 1,
    sha256: "482acea1418674a165fb2691690b789656d3acd3b0866a889c9bfe1929bf5912",
    path: "generated/ReviewReport.v1.schema.json",
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
    schemaId: "heniek://contract/RunAnswerRequest/v2",
    schemaVersion: 2,
    sha256: "e84ca2f90d9b689e8faaaf044906d6ffd791742b2043ab90ef04cba88606a3ee",
    path: "generated/RunAnswerRequest.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/RunnerExternalObservation/v1",
    schemaVersion: 1,
    sha256: "82331233dbdf6c250a7004ce74db470130c8f1e9b0a6c25ec7c030bef0ad60d5",
    path: "generated/RunnerExternalObservation.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RunnerReconciliationTrace/v1",
    schemaVersion: 1,
    sha256: "aac8e3e423dd31de7ce8d287bc52bc9ea8446630be67d88ec674c24d2f71cccf",
    path: "generated/RunnerReconciliationTrace.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RunRecoveryClassification/v1",
    schemaVersion: 1,
    sha256: "bd4fe19884b2fcf1f6377f202def77a6cf7fce170349ee186bfdc7bf504b077c",
    path: "generated/RunRecoveryClassification.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/RunResumeRequest/v2",
    schemaVersion: 2,
    sha256: "02fb218210633df96e45324c297ed3228ac605768a52bcc1e452d4f71d549c66",
    path: "generated/RunResumeRequest.v2.schema.json",
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
    schemaId: "heniek://contract/SchedulingDecision/v1",
    schemaVersion: 1,
    sha256: "f637fec752c38c6c441fc359cb8035a52958a4fed87f604cd45e71ded268fc0a",
    path: "generated/SchedulingDecision.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/SchedulingDecision/v2",
    schemaVersion: 2,
    sha256: "27b87dbe1727aab276a0db642c2511942bfba9bc1da7c52ca4c7d68ee20d8049",
    path: "generated/SchedulingDecision.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunAnswerResult/v2",
    schemaVersion: 2,
    sha256: "f2a8f8fc1020ec5371e769db12fe0aeaca865caa669077d7c35167a29efc265c",
    path: "generated/StageRunAnswerResult.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunMutationResult/v1",
    schemaVersion: 1,
    sha256: "7491e0d1842751707d3658b7c71c058f1d2a6b1194d8c6752511b8293f1c9e3b",
    path: "generated/StageRunMutationResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunnerAttempt/v1",
    schemaVersion: 1,
    sha256: "ab1571a13ead88a053c4f306da73a6ec3cc82a0e33cb04284d844e89949ab6cc",
    path: "generated/StageRunnerAttempt.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunnerAttempt/v2",
    schemaVersion: 2,
    sha256: "73d9eeb4eda56623a1bde7906c487afa4c4a1dc1b2310a2469c34feef698fb92",
    path: "generated/StageRunnerAttempt.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunnerCleanupReport/v1",
    schemaVersion: 1,
    sha256: "758ced5a5e0420fce684e0c0db8dc5db5b26b35ec606bc8dfbd2ce964a231cb2",
    path: "generated/StageRunnerCleanupReport.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunnerEvidence/v1",
    schemaVersion: 1,
    sha256: "c956b4036e5e694143e2d065c5737b4d9caecb46c97348d4b0bdc500cecbb7a4",
    path: "generated/StageRunnerEvidence.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunnerFailure/v1",
    schemaVersion: 1,
    sha256: "54a662499ffd7fca7a3c759de202654de6730c9fce472c4b2c41821230394445",
    path: "generated/StageRunnerFailure.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunnerFailure/v2",
    schemaVersion: 2,
    sha256: "044022053b49f76a925fbeb7a79ce0925d914628beea1082471f25b7fafb6ea7",
    path: "generated/StageRunnerFailure.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunnerOutputBinding/v1",
    schemaVersion: 1,
    sha256: "0c83997fc9b6c9c6a666636126be0d9cd98b7e025e009a33ca7a7f2116378e6d",
    path: "generated/StageRunnerOutputBinding.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunnerResult/v1",
    schemaVersion: 1,
    sha256: "04f14137e47e8428d5c5b39e35ff569abbead1b2a838f61f6acce29758057948",
    path: "generated/StageRunnerResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunnerResult/v2",
    schemaVersion: 2,
    sha256: "58f21ec54d27a52216370c451e83aa90988bffa6afe63f956d28878ca459a5e1",
    path: "generated/StageRunnerResult.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunnerValidationReport/v1",
    schemaVersion: 1,
    sha256: "2df094eabff37623b983997fa45a011a0d4abaf76a45d0dfa0551407de60373c",
    path: "generated/StageRunnerValidationReport.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunResult/v1",
    schemaVersion: 1,
    sha256: "8f0faffeabe166f355b7033e9a45b6cf2bae829d1ab64ab10f086fce501fc8fa",
    path: "generated/StageRunResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunResult/v2",
    schemaVersion: 2,
    sha256: "046a7e45967777b4ebb50bfb734207a8a369b90d50002768891e3e6d50f715d9",
    path: "generated/StageRunResult.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunResult/v3",
    schemaVersion: 3,
    sha256: "0bcc4f412bf6574a4f75f26b77979fa6c56963497e8a16efc886bfd119959557",
    path: "generated/StageRunResult.v3.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunResult/v4",
    schemaVersion: 4,
    sha256: "9935b7c812af5dd7383741e39338885d619b0816e69395fd19284aadbe12ec5b",
    path: "generated/StageRunResult.v4.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunResumeResult/v2",
    schemaVersion: 2,
    sha256: "39164d439fdce631fadae6a7baa7ca926d6c3fc76b76c25f8f9411e6da65b4c7",
    path: "generated/StageRunResumeResult.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunStatusResult/v1",
    schemaVersion: 1,
    sha256: "69c0bd03d97d24dab4ee7b8b552b224ec23ddc5536db25e08bdd70b82a88fc79",
    path: "generated/StageRunStatusResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunStatusResult/v2",
    schemaVersion: 2,
    sha256: "f9d6117ced1e9ecf64569e2a15285e13999d0d67cd28e83f6b909a7df0c15601",
    path: "generated/StageRunStatusResult.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunStatusResult/v3",
    schemaVersion: 3,
    sha256: "4812a646b8cf1b9d4f7cabfca9e96c1fb8b24857caf3d48fc2c855ea8caa0eb4",
    path: "generated/StageRunStatusResult.v3.schema.json",
  },
  {
    schemaId: "heniek://contract/StageRunStatusResult/v4",
    schemaVersion: 4,
    sha256: "448d39bcafb560b28c47b04c07ae649e2053d7674e6ca6bd15d8ac448fd6ef09",
    path: "generated/StageRunStatusResult.v4.schema.json",
  },
  {
    schemaId: "heniek://contract/StageStartRequest/v2",
    schemaVersion: 2,
    sha256: "8b8ed13a64c711cb9c6700a13b291b8a770e9347a1652d84c77f0cbc8f7efcaf",
    path: "generated/StageStartRequest.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/StageStartRequest/v3",
    schemaVersion: 3,
    sha256: "230438d2d02eb9966f95e135d5f130aca5c4c33664070538cb08cf1417b74c67",
    path: "generated/StageStartRequest.v3.schema.json",
  },
  {
    schemaId: "heniek://contract/StageStartResult/v1",
    schemaVersion: 1,
    sha256: "35776620780b4a150ab249801125096c4edfd9bfb8713c5c3e57e3d41c616341",
    path: "generated/StageStartResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/StageStartResult/v2",
    schemaVersion: 2,
    sha256: "f3b5fc903ec2b65c6541b16c753974f7dabd77c44eee941317cec492bd3be6cd",
    path: "generated/StageStartResult.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/StageStartResult/v3",
    schemaVersion: 3,
    sha256: "d5af71ad48d08b715ebf38715e04186466414c1eb4723e13664244439c989715",
    path: "generated/StageStartResult.v3.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskCapacityLease/v1",
    schemaVersion: 1,
    sha256: "4742e85d862dba743325f22dd4bffa9338aebd12a6bce9ea6e470cef8ba5c19d",
    path: "generated/TaskCapacityLease.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskContext/v1",
    schemaVersion: 1,
    sha256: "d183f2b0159e2b92fa36737ecaa320995a14cf012ee3fc7af3bf9e529f24586b",
    path: "generated/TaskContext.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskContext/v2",
    schemaVersion: 2,
    sha256: "3d16d07d236d32ccb02184775d5a6ad5b6e110e5bb914210212d64ce4a877e15",
    path: "generated/TaskContext.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskDag/v1",
    schemaVersion: 1,
    sha256: "b9f36f7e2d162c3370d0885337242629fbf07df55608ab1596f8968ea50b59a2",
    path: "generated/TaskDag.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskDag/v2",
    schemaVersion: 2,
    sha256: "9279229657d7c17747101ed066233d353e0e0cee3202d885c5765ab96ce47251",
    path: "generated/TaskDag.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskDagValidationResult/v1",
    schemaVersion: 1,
    sha256: "af564a85187e07e4d7d21113d31d2f06a44a225e7a3ba8a4bb332fbd3d22462a",
    path: "generated/TaskDagValidationResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskDispatchRecord/v1",
    schemaVersion: 1,
    sha256: "da35396b6668426dbd5df6ef2be95d7ea516629404145c62ebde1bdad33877c1",
    path: "generated/TaskDispatchRecord.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskGraphRevisionDecision/v1",
    schemaVersion: 1,
    sha256: "aed9fcaf889f302266f69afbaa71e6392e3c66bacf866e91456e22852dfc474c",
    path: "generated/TaskGraphRevisionDecision.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskGraphRevisionDecision/v2",
    schemaVersion: 2,
    sha256: "4a6bb150b9850cf1206a80344f92f088f2095c8e5e005448c1b9415e4aa8298a",
    path: "generated/TaskGraphRevisionDecision.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskGraphRevisionProposal/v1",
    schemaVersion: 1,
    sha256: "3e30f62d684010f8026a53ad63ce474f6b8563ce6f7f111331835fd8d68a10d9",
    path: "generated/TaskGraphRevisionProposal.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskGraphRevisionProposal/v2",
    schemaVersion: 2,
    sha256: "f15ba7214f07fdb500215eb2d37999dd38179ed71abde828a83289227af078ee",
    path: "generated/TaskGraphRevisionProposal.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskGraphRevisionRecord/v1",
    schemaVersion: 1,
    sha256: "222d32c1b9f243265eece81a15b5ccccd9a5a23023df2acced5f289410e2c900",
    path: "generated/TaskGraphRevisionRecord.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskGraphRevisionRecord/v2",
    schemaVersion: 2,
    sha256: "a50c62e254fa271cba946549614eb985ae202a67e769e0a49efea08a6d057e7c",
    path: "generated/TaskGraphRevisionRecord.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskHierarchy/v1",
    schemaVersion: 1,
    sha256: "a5234c9b71d75be9b35214cd2eb7751fb50a2089318fd6b2143d490ae208fb23",
    path: "generated/TaskHierarchy.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskIntegrationLedgerEntry/v1",
    schemaVersion: 1,
    sha256: "8a9f2a1cb1525ec90a1c816f88174efa749313ebdf42249579c0aa3793aa3a15",
    path: "generated/TaskIntegrationLedgerEntry.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskIntegrationReconciliation/v1",
    schemaVersion: 1,
    sha256: "77e34051462b4b41d4f406e7740c8d61dfc7b7ed974051b4225946a1be11cd64",
    path: "generated/TaskIntegrationReconciliation.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskIntegrationReconciliationObservation/v1",
    schemaVersion: 1,
    sha256: "c22edcd95a0a00d730bc426eec58fe3799d9f99ca26820990eda725a8694c0f5",
    path: "generated/TaskIntegrationReconciliationObservation.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskIntegrationTrace/v1",
    schemaVersion: 1,
    sha256: "e62e0881ac7a0ab06fd3192cffa029e338ddcce9bbcc6a9a49264ad469a389e7",
    path: "generated/TaskIntegrationTrace.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskLifecycleProjection/v1",
    schemaVersion: 1,
    sha256: "c42d486035c4aab0c1d5f166757abc92272fcac6edf2683e7cfe5c2ebdc67a8b",
    path: "generated/TaskLifecycleProjection.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskPropagationReason/v1",
    schemaVersion: 1,
    sha256: "3742cb0e0279c74fd957967c2bb27bd6ad96731d0b638345526dcef709edd5a5",
    path: "generated/TaskPropagationReason.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskRevision/v1",
    schemaVersion: 1,
    sha256: "d01c27bf2740b13fe9f345740ab717e121abe8550df124a0e66215d1ff8f50a7",
    path: "generated/TaskRevision.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskRevisionDocument/v1",
    schemaVersion: 1,
    sha256: "8c837d159b1a3d42b54a9855247b9009cd18d0b9f458e2419ef7e4c6a92c54bb",
    path: "generated/TaskRevisionDocument.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskSourceSnapshot/v1",
    schemaVersion: 1,
    sha256: "b8e9b720806991b710f8d723428883c6d8d8c142a447588bcd595b3c13f8dfcc",
    path: "generated/TaskSourceSnapshot.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskSourceSnapshot/v2",
    schemaVersion: 2,
    sha256: "387f3f73c4b9af015822d4c49ee549ecbf6a4dd11a7396b8db24bfd5c4e7851c",
    path: "generated/TaskSourceSnapshot.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskSourceSynchronizationAudit/v1",
    schemaVersion: 1,
    sha256: "676a4533cb29e6d46225b476d9f253cbeeb0b0c0a393097e7fa628dff89b18f9",
    path: "generated/TaskSourceSynchronizationAudit.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskSourceUpdateProposal/v1",
    schemaVersion: 1,
    sha256: "847b660c64ba70370feeaf8960676e7885a60cd7ef9c1ec897fb12ceedad3589",
    path: "generated/TaskSourceUpdateProposal.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskWaveAuditEvent/v1",
    schemaVersion: 1,
    sha256: "900f0e82c1004c903e0bcee44301ac189035f97dd4be5af092bfa20610dce707",
    path: "generated/TaskWaveAuditEvent.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskWavePlan/v1",
    schemaVersion: 1,
    sha256: "e10214e01aee693d4561d21f4f2af9e952f7ee695cd6dbbd8682bfbde47a4b31",
    path: "generated/TaskWavePlan.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskWavePlanningSnapshot/v1",
    schemaVersion: 1,
    sha256: "6bb27925984085a0c216b483300b7cdbacd4311be2143939d7d90cdc5f8b3a58",
    path: "generated/TaskWavePlanningSnapshot.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskWavePlanningSnapshot/v2",
    schemaVersion: 2,
    sha256: "562f68e8d8b76d02c7c5cf1f2964079b7ff616e9e4885c7863270815d850fe9a",
    path: "generated/TaskWavePlanningSnapshot.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/TaskWorkspaceBinding/v1",
    schemaVersion: 1,
    sha256: "fcb85bddd5fd0060468f23ba4ac6f90246bb085818241a04de66f1331ea73106",
    path: "generated/TaskWorkspaceBinding.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/VariantIntegrationRequest/v1",
    schemaVersion: 1,
    sha256: "d0c57fec9a67ab44b83a3e81eac0cfce122365a42dcce602b907ffb7a4769b04",
    path: "generated/VariantIntegrationRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/VariantIntegrationResult/v1",
    schemaVersion: 1,
    sha256: "313e0af114c04ca9bb6bb5c473d7008bf0671903c18e75683d230b0ae28658b2",
    path: "generated/VariantIntegrationResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/VariantIntegrationTrace/v1",
    schemaVersion: 1,
    sha256: "325395b3a8923f936ff08a5c67b60d58b8e83d6c50e70bb4e2ed674712e6735d",
    path: "generated/VariantIntegrationTrace.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/VerifyCheck/v1",
    schemaVersion: 1,
    sha256: "e02774c22149725ec94915721fdafe50fe984d5fd25bea1ea14d85268eb432f0",
    path: "generated/VerifyCheck.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/VerifyCheckEvidence/v1",
    schemaVersion: 1,
    sha256: "75c685b97c394f0b4580b980de10269e69e8a81a9f1a6d7466396778a79ef389",
    path: "generated/VerifyCheckEvidence.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/VerifyRequest/v1",
    schemaVersion: 1,
    sha256: "5935b7b1c0e814838bb5e0d41935671ff516f7e2f5225cf9eb838ca75af1eaf3",
    path: "generated/VerifyRequest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/VerifyResult/v1",
    schemaVersion: 1,
    sha256: "325c24d71790dd8ae6dfd48e2f41d4c9a9144f51512e2e3f34221a5ce4e86260",
    path: "generated/VerifyResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/WholeCodebaseAnalysisPacket/v1",
    schemaVersion: 1,
    sha256: "1b6386b3715332b54e29ea8dd8f21330ab7b70df35870a86bd6e1d3bf59e73e1",
    path: "generated/WholeCodebaseAnalysisPacket.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/WorkspaceCleanupResult/v1",
    schemaVersion: 1,
    sha256: "cf7349ff8e741ca01d529a99f48e25629beae011be7c084259619483cb08fc7f",
    path: "generated/WorkspaceCleanupResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/WorkspaceConfiguration/v1",
    schemaVersion: 1,
    sha256: "53f2eef07832e93707729cd0ee79be2a9e9b17ee9fc85a4bf1e95c2da1bf3710",
    path: "generated/WorkspaceConfiguration.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/WorkspaceConfiguration/v2",
    schemaVersion: 2,
    sha256: "1378a7c998e5bd5d2d392aac6e0ce282256b329817c1046c2afd16047552c8e9",
    path: "generated/WorkspaceConfiguration.v2.schema.json",
  },
  {
    schemaId: "heniek://contract/WorkspaceDiffInventory/v1",
    schemaVersion: 1,
    sha256: "1baf590aff50161e5bfe33e308cf473cd334b2d77d11026d41dd3c869e73c37e",
    path: "generated/WorkspaceDiffInventory.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/WorkspaceProvisioningManifest/v1",
    schemaVersion: 1,
    sha256: "0d69e2a405e4c7b65cb9da6da833c502fdb83b21f102e212b86abcb43e742b54",
    path: "generated/WorkspaceProvisioningManifest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/WorkspaceRecoveryDecisionTrace/v1",
    schemaVersion: 1,
    sha256: "0a2110211922a140ba42c94cc77d68cf3bda3c61a5fc2d29c0808d61b68ae890",
    path: "generated/WorkspaceRecoveryDecisionTrace.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/WorkspaceSynchronizationResult/v1",
    schemaVersion: 1,
    sha256: "2fe27587400747272e5acf288c4ab05d0495bf216c7e3fdf1d97e0ef1278abbf",
    path: "generated/WorkspaceSynchronizationResult.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/WorkspaceVariantManifest/v1",
    schemaVersion: 1,
    sha256: "75bc2ea16a2d503c4b291ee0ed1ab43e6b57e10ac37545f1313200effdd205e3",
    path: "generated/WorkspaceVariantManifest.v1.schema.json",
  },
  {
    schemaId: "heniek://contract/WorkspaceWriterLease/v1",
    schemaVersion: 1,
    sha256: "75b0e5e7d04c02d73266ce663bd691d3a9d26d017e459faaee50a7d31e05c18d",
    path: "generated/WorkspaceWriterLease.v1.schema.json",
  },
];

describe("packages/contracts generated manifest is unchanged (AC4)", () => {
  it("manifest.json lists exactly the 242 known schemas with their recorded sha256", async () => {
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
