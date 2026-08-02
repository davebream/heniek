import { Type } from "@sinclair/typebox";
import { versioned } from "../kernel/index.js";
import { ArtifactId } from "./ids.js";

/**
 * The immutable, final-location reference to one artifact (§16.2:
 * artifacts are immutable; §16.6: moved to an immutable final path only
 * after the stage-completion transaction validates it). Deliberately has
 * no back-reference to a run or stage — ownership is expressed the other
 * way, by whichever entity holds an `ArtifactId`, keeping this family
 * dependency-free below `kernel` and avoiding an import cycle with `run`.
 *
 * `producer` is the identity of the worker/profile that produced the
 * artifact — an opaque label such as an engine, profile or tool identity
 * (e.g. `heniek-cli@0.0.0`). It is **not** a stage id and **not** a run id,
 * so it does not contradict the "no back-reference to a run or stage" claim
 * above: `producer` records *who* produced the artifact, never *where* (a
 * run/stage) it was produced.
 *
 * `contentSchemaId` carries the content's schema *version*, distinct from
 * `schemaVersion` above (which is ArtifactRef's own envelope version and
 * cannot vary per artifact). It is pattern-constrained to the canonical
 * schema-id shape this repo's own contracts use
 * (`heniek://contract/<Name>/v<N>`, `kernel/version.ts`'s `versioned()`), so
 * a value that omits a version component is rejected by construction rather
 * than by unwritten convention.
 *
 * `sourceLineage` is bounded to `maxItems: 64` (and deduplicated via
 * `uniqueItems: true`, since lineage is a set) so a single ref has a
 * computable maximum size under the 64 KiB event-payload cap
 * (`MAX_PAYLOAD_BYTES`, `packages/state/src/journal/append.ts`). Arithmetic:
 * a `sourceLineage` entry is a JSON-quoted opaque `ArtifactId` string; at a
 * generous ~48 bytes per quoted id+comma, 64 entries serialize to
 * ~3,072 bytes (3 KiB) — under 5% of the 65,536-byte cap, leaving the
 * overwhelming majority of the budget for the ref's other fields and for
 * Task 4.2's separate, payload-cap-driven artifact-count check.
 */
export const ArtifactRefV1 = versioned("ArtifactRef", 1, {
  artifactId: ArtifactId,
  path: Type.String({
    minLength: 1,
    description:
      "Output-only, derived from contentHash as `blobs/sha256/<contentHash>`. " +
      "A caller-supplied value that disagrees with the derived path is refused (design D8).",
  }),
  contentHash: Type.String({ pattern: "^[a-f0-9]{64}$", description: "sha256, hex-encoded" }),
  createdAt: Type.String({ format: "date-time" }),
  name: Type.String({ minLength: 1 }),
  byteLength: Type.Integer({ minimum: 0 }),
  mediaType: Type.String({ minLength: 1 }),
  contentSchemaId: Type.String({
    minLength: 1,
    pattern: "^heniek://contract/[A-Za-z][A-Za-z0-9]*/v[1-9][0-9]*$",
    description:
      "A schema identifier that embeds a version, e.g. `heniek://contract/<Name>/v<N>` " +
      "— this is how the ref preserves the content's schema version. " +
      "Pattern-constrained so a non-version-bearing id is rejected by construction.",
  }),
  producer: Type.String({
    minLength: 1,
    description:
      "Opaque identity of the worker/profile that produced the artifact (an engine, " +
      "profile or tool identity, e.g. `heniek-cli@0.0.0`) — not a run or stage id.",
  }),
  sourceLineage: Type.Array(ArtifactId, {
    maxItems: 64,
    uniqueItems: true,
    description:
      "Bounded so a single ref has a computable maximum size under the event-payload cap.",
  }),
});
