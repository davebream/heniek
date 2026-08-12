# Q040 requirement traceability

| Requirement | Evidence |
|---|---|
| Reject cycles and missing nodes | `task DAG validation` cycle/missing fixtures |
| Reject impossible write conflicts | unordered-writer rejection and serialized-writer acceptance fixtures |
| Reject invalid terminal dependencies | active-after-failed-predecessor fixture |
| Respect dependency and verification gates | completion, integration, and combined-verification fixture |
| Respect writer leases and capacity | profile, lease, account, and run-limit fixtures |
| Explain every deferred task | `TaskWavePlanV1.decisions[].blockingReasons` contract and assertions |
| Deterministic topological waves | permutation and simulated-wave property tests |
| Preserve public compatibility | four additive v1 schemas and updated compatibility manifest baseline |

