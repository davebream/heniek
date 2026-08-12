# Q044 requirement traceability

| Requirement | Implementation evidence | Test evidence |
|---|---|---|
| Enumerate partial states and safe actions | ADR 0042 state table and non-atomic forward-only policy | Contract and daemon reconciliation suites |
| Truthful terminal or typed-blocked state after restart | Durable reconciliation projection with exact-SHA classification | Partial first/last-ref interruption, external mutation, missing ref, and identity mismatch cases |
| Idempotent retries with every observation retained | Causal projection plus append-only per-pass observation table | Repeated identical observation test records three passes while resolving once |
| Observe all before mutation | Two-phase daemon pass classifies the complete repository set before selected publication | Multi-repository call-order assertions and zero-publication blocked cases |
| No destructive rollback | Only expected-to-candidate CAS and exact-candidate adoption are permitted | Partial progress is preserved; divergent heads remain unchanged |
| Compatible public contracts | Two additive V1 schemas; Q043 schema digests pinned byte-for-byte | Q044 contract compatibility test and generated-schema check |
| Durable migration | Migration 25 replaces only the Q043 terminal guards needed for explicit resolution and adds causal/immutable reconciliation tables | v24 upgrade, terminal guard, observation immutability, migration hash, and schema fingerprint tests |
