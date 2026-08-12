# Q039 requirement traceability

| Requirement | Contract/runtime evidence | Test evidence |
|---|---|---|
| Preserve source URI, hash, requirements, attachments, and observed version | `TaskSourceSnapshotV1`; artifact-backed ingestion | Contract validation and task-source persistence/idempotency tests |
| Link revisions to predecessor, author/reason, diff, and supersession | `TaskRevisionV1`; immutable revision table and active projection | JSON Patch replay and seeded 25-revision chain tests |
| Keep tracker hierarchy distinct from execution dependencies | `TaskHierarchyV1`; separate tracker-edge and execution-mapping tables | Contract separation and hierarchy persistence tests |
| Preserve immutable source observations | Snapshot update/delete triggers; unique source URI/version | Immutability and conflicting-observed-version tests |
| Persist canonical state outside registered repositories | Application-home artifact store and SQLite migration 21 | Restart reload and artifact recovery tests |
| Maintain public schema evidence | Checked-in schemas and manifest compatibility pin | Contract generation and conformance compatibility suites |

Q039 deliberately excludes GitHub fetching/mutation, graph validation/scheduling, and branch/PR adoption.
