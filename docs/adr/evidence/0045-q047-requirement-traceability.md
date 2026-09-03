# Q047 requirement traceability

| Requirement | Implementation | Verification |
|---|---|---|
| Issue create/read/update/adopt return stable refs and observed versions | V3 issue contracts; REST adapter normalization; hidden linkage digest; post-write read | Shared issue lifecycle and stale-version cases; accepted-write recovery test |
| Ref and branch writes reject unexpected SHAs without force | V3 ref contracts; GraphQL `updateRefs` with exact `beforeOid` and `force: false` | Shared branch cases; temporary-repository forward/divergent-history test |
| PR draft default, stable linkage, base/head identity, and safe update | `CreatePullRequestInput/v2`, `PullRequest/v2`, marker adoption, expected head and metadata version | Shared draft/adoption and update-fencing cases; disconnect recovery test |
| Check summary and mergeability observation | Separate `PullRequestStatus/v1`; GraphQL rollup, requiredness, and merge-state normalization | Shared status-summary case and recorded CheckRun failures |
| Provider-neutral compatibility | V1/V2 interfaces preserved; 15 additive generated schemas; GitHub DTOs remain adapter-internal | Contract provider-leakage tests; manifest fingerprint pin; generation check |
| Least privilege and secret safety | Separate read/write transports; typed redacted errors; no Administration API | Permission/redaction and authenticated-origin tests |
| No runtime or workflow expansion | Packages expose primitives only; no state schema, daemon service, or delivery-runner wiring | Diff inspection and full regression suite |
