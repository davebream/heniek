# Q027 runner conformance matrix

Provider-neutral lifecycle assertions exercised by package suites against fake
Git/Forge adapters (no GitHub credentials).

| Stage | Waiting | Restart reconstruct | Idempotent side effect | Typed failure classes |
| --- | --- | --- | --- | --- |
| approval | yes — inbox + CAS answer | yes — operation request + answer ledger | duplicate answer / stale revision refused | `rejected`, `stale_revision`, `cancelled` |
| integration | no (sync) | yes — request + external observations | CAS ref update; already-applied adopt | `stale_sha`, `merge_conflict`, `reconciliation_required` |
| verify | no (ordered checks) | yes — completed result replay | argv/`shell: false` evidence | `malformed_contract`, `process_failed`, `cancelled`, `timeout` |
| publish | no (forge I/O) | yes — find-before-create adoption | unique PR adopt; ready/auto-merge policy | `forge_failed`, `reconciliation_required` (`mismatched_head`, `ambiguous`) |
| agent | yes (`waiting_on_user`) | observe handle or `recovery_required` | unchanged from Q026 | unchanged V1 classes |
| command | no | reap or `recovery_required` | unchanged from Q026 | unchanged V1 classes |

Coordinator invariants:

- Workspaces provisioned only for agent/command/integration/verify.
- Waiting attempts do not block draining other scheduler intents.
- Operation request rows exist before Git `update-ref` or Forge create/adopt.
