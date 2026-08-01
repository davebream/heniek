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
 */
export const ArtifactRefV1 = versioned("ArtifactRef", 1, {
  artifactId: ArtifactId,
  path: Type.String({ minLength: 1 }),
  contentHash: Type.String({ pattern: "^[a-f0-9]{64}$", description: "sha256, hex-encoded" }),
  createdAt: Type.String({ format: "date-time" }),
  name: Type.String({ minLength: 1 }),
  byteLength: Type.Integer({ minimum: 0 }),
  mediaType: Type.String({ minLength: 1 }),
  contentSchemaId: Type.String({ minLength: 1 }),
  producer: Type.String({ minLength: 1 }),
  sourceLineage: Type.Array(ArtifactId),
});
