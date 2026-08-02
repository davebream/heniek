/**
 * Classification result of a post-crash reconciliation probe (design C-1,
 * `## Alternatives Considered` Option D). Deliberately a **plain tuple, not
 * `defineStates`** — `defineStates` (`../kernel/state.js`) enforces a
 * terminal/non-terminal partition a classification result does not have.
 *
 * This is **not** a `RunStatus` value: it is a property of *this* recovery
 * pass, re-derived by probing on every start, not of a run's persistent
 * identity. `Run/v1`'s pinned digest (`be0a661b93de…`) is therefore
 * untouched by this addition.
 */
export const RunRecoveryClass = ["resumable", "failed", "cancelled", "unknown"] as const;
export type RunRecoveryClass = (typeof RunRecoveryClass)[number];
