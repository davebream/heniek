# Q046 GitHub TaskSource conformance

The real `@heniek/task-source-github` adapter runs the shared TaskSource catalogue against recorded,
credential-free GitHub responses. The same suite also exercises adapter-specific paging, attachment,
conditional-read, persistence, and synchronization behavior.

| Contract behavior | Evidence |
|---|---|
| Contract-valid load and deterministic replay | Shared lifecycle cases return `TaskContext/v2` and repeat byte-identically |
| Malformed and unsupported input | Shared rejection cases map neutral fixtures to invalid GitHub references |
| External revision handling | Shared revision case records one pending update without advancing the accepted revision |
| Rate-limit classification | A recorded `403` with exhausted quota classifies as `rate_limit` |
| Conflict classification | The shared stale-source case maps the adapter conflict to the neutral vocabulary |
| Complete snapshot | Two comment pages, parent, cross-repository sub-issue, labels, and state normalize deterministically |
| Conditional read | A root ETag is sent through `If-None-Match`; `304` reuses the cached representation |
| Attachment security | An allowlisted attachment redirect to a foreign host is rejected before credentials can be sent |
| Idempotent synchronization | Concurrent duplicate calls post once and return the same immutable audit |
| Crash recovery | A simulated disconnect after accepted POST is recovered by adopting the hidden marker |
| Restart durability | A completed audit is byte-identical after closing and reopening SQLite |
| Credential non-leakage | Authorization is limited to the API origin and errors/JSON exclude the token value |

Recorded fixtures contain only synthetic `acme/*` repositories, synthetic node IDs, and redacted request IDs.
No live GitHub credential or response body is committed.
