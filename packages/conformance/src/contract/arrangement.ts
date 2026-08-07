import type { CheckState } from "@heniek/contracts";
import type { FaultKind } from "./fault.js";

/**
 * A `PendingInteractionV1.kind` mirror. Not imported from `@heniek/contracts`
 * because that literal union is only reachable through the compiled schema,
 * not exported as a standalone type; three literals is cheap to keep in sync
 * by hand (the same tradeoff the contracts package itself makes for
 * `interaction`'s `InteractionKind`, see `packages/contracts/src/interaction/schemas.ts`).
 */
export type PendingInteractionKind = "free_text" | "single_choice" | "multiple_choice";

/** Provider-neutral preconditions the execution-backend catalogue can arrange. */
export type ExecutionArrangement =
  | { readonly kind: "completes"; readonly status: "succeeded" | "failed" }
  | { readonly kind: "asks-question"; readonly interactionKind: PendingInteractionKind }
  | { readonly kind: "emits-malformed-result" }
  | { readonly kind: "injects-fault"; readonly fault: FaultKind; readonly occurrences: number };

/** Provider-neutral preconditions the task-source catalogue can arrange. */
export type TaskSourceArrangement =
  | { readonly kind: "resolves" }
  | { readonly kind: "malformed-input" }
  | { readonly kind: "unknown-source-kind" }
  | { readonly kind: "revised"; readonly times: number }
  | { readonly kind: "injects-fault"; readonly fault: FaultKind; readonly occurrences: number };

/** Provider-neutral preconditions the forge-backend catalogue can arrange. */
export type ForgeArrangement =
  | { readonly kind: "clean" }
  | { readonly kind: "checks"; readonly states: readonly CheckState[] }
  | { readonly kind: "stale-head" }
  | { readonly kind: "injects-fault"; readonly fault: FaultKind; readonly occurrences: number };
