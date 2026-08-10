/**
 * Provider-neutral preconditions for PipelineRuntime catalogue cases (Q032).
 */
export type PipelineRuntimeArrangement =
  | { readonly kind: "clean" }
  | { readonly kind: "non-quiescent-target" };
