import { defineStates } from "../kernel/index.js";

/** Verbatim per Product Specification v0.2 §22. */
export const ExecutionStatus = defineStates({
  nonTerminal: ["queued", "running", "waiting_on_user", "recovery_required"],
  terminal: ["succeeded", "failed", "cancelled"],
});
export type ExecutionStatus = (typeof ExecutionStatus)["values"][number];
