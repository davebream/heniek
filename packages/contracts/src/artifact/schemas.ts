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
    description:
      "A schema identifier that embeds a version, e.g. `heniek://contract/<Name>/v<N>` " +
      "— this is how the ref preserves the content's schema version.",
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
