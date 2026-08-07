import type { Static } from "@sinclair/typebox";
import { defineIdNamespace } from "../kernel/index.js";

export const CodebaseId = defineIdNamespace("CodebaseId");
export type CodebaseId = Static<typeof CodebaseId>;

export const RepositoryId = defineIdNamespace("RepositoryId");
export type RepositoryId = Static<typeof RepositoryId>;

export const WorkspaceId = defineIdNamespace("WorkspaceId");
export type WorkspaceId = Static<typeof WorkspaceId>;

export const RunId = defineIdNamespace("RunId");
export type RunId = Static<typeof RunId>;
