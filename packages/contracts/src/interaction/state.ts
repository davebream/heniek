import { defineStates } from "../kernel/index.js";

/**
 * Canonical, durable question/answer lifecycle (§16.1/§17 — distinct from
 * `ExecutionStatus`'s `waiting_on_user`, which is the *run's* status while
 * one of its interactions is `pending`).
 */
export const InteractionStatus = defineStates({
  nonTerminal: ["pending"],
  terminal: ["answered", "cancelled"],
});
export type InteractionStatus = (typeof InteractionStatus)["values"][number];
