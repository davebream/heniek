import type { Static } from "@sinclair/typebox";
import { defineIdNamespace } from "../kernel/index.js";

export const AccountId = defineIdNamespace("AccountId");
export type AccountId = Static<typeof AccountId>;

export const WorkerId = defineIdNamespace("WorkerId");
export type WorkerId = Static<typeof WorkerId>;

export const RoleId = defineIdNamespace("RoleId");
export type RoleId = Static<typeof RoleId>;
