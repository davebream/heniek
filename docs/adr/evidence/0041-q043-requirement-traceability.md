# Q043 requirement traceability

| Requirement | Implementation | Deterministic evidence |
|---|---|---|
| One epic branch per changed repository | Causal branch projection persists the supplied branch map and recorded base SHA | Contract and service tests cover two repository branches |
| Restart-safe branch adoption | Initialization accepts only the recorded local SHA and an absent/equal remote ref | Duplicate-tick/restart and remote-movement tests |
| Deterministic serialized integration | Ledger ordinal is wave order plus canonical task order; only its first non-terminal entry progresses | Reverse-completion test still integrates `a` before `b` |
| Combined verification before publication | `prepared → verified → integrated` calls the verification driver before publish | Driver call trace and verification-failure test |
| Expected-SHA safety | Publication results advance epic expected SHAs transactionally with ledger and task gates | Migration/store invariants and expected-SHA trace |
| Recovery without duplicate side effects | Prepared and verified states resume at their next boundary | Interrupted verification/publication test |
| Reconciliation on unsafe observations | Remote/local drift, merge conflict, stale refs, undeclared writes, and partial progress are terminal reconciliation states | Remote/local movement, conflict/stale-target, undeclared-write, and partial-publication tests |
| Public compatibility | Three additive V1 schemas; previous generated files are not rewritten | Contract generation and compatibility suite |
