# Q046 requirement traceability

| Requirement | Implementation evidence | Verification |
|---|---|---|
| Normalize issues, comments, attachments, hierarchy, labels, and state | `TaskSourceSnapshot/v2` plus the GitHub adapter's bounded pagination and normalization | Recorded multi-page and hierarchy fixture test |
| Preserve source snapshot, ETag/version, and mutation provenance | Component observations, content-addressed artifacts, composite version, immutable synchronization audit | Contract, state migration, conditional-304, and restart tests |
| Idempotent updates with observed-version guards | Durable unique claim, deterministic marker, expected/current versions in every audit | Concurrent duplicate and crash-adoption tests |
| Never silently lose concurrent human edits | No issue-field mutation; stale observations produce append-only merge proposals and typed conflicts | Stale-source synchronization test |
| Least-privilege credentials | Separate injected read/write transports; default transport authenticates only configured API origins | Authorization-origin and redaction test |
| Provider-neutral public surface | GitHub DTOs are package-private; generated contracts contain source/task vocabulary only | Schema compatibility suite |
| Compatible or deliberate schema versioning | V1 remains pinned; V2 context/snapshot and V1 proposal/audit are additive | Generated manifest compatibility suite |
| Preserve Q047/Q048 boundaries | No issue creation, direct field mutation, ForgeBackend, branch/PR, or materialization modes | ADR boundary and package dependency review |
