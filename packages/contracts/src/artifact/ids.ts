import type { Static } from "@sinclair/typebox";
import { defineIdNamespace } from "../kernel/index.js";

export const ArtifactId = defineIdNamespace("ArtifactId");
export type ArtifactId = Static<typeof ArtifactId>;
