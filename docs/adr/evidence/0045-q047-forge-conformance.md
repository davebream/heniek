# Q047 GitHub ForgeBackend conformance

The provider-neutral forge catalogue contains 18 cases. It runs unchanged against both the in-memory
`ForgeBackendV3` fake and the real `@heniek/forge-github` adapter backed by recorded, credential-free REST and
GraphQL responses.

| Contract behavior | Fake | Recorded GitHub adapter |
|---|---:|---:|
| Existing V1 create, draft, ready, checks, failure-log, and auto-merge behavior | Pass | Pass |
| Issue create/adopt and observed-version update | Pass | Pass |
| Stale issue-version conflict | Pass | Pass |
| Branch create/adopt and exact-SHA update | Pass | Pass |
| Unexpected branch ref rejected without overwrite | Pass | Pass |
| Pull request defaults to draft and adopts by linkage | Pass | Pass |
| Pull-request metadata/head fencing | Pass | Pass |
| Mergeability and required-check summary | Pass | Pass |
| Disconnect and rate-limit classification | Pass | Pass |

Adapter-specific tests add coverage that does not belong in the provider-neutral catalogue:

- Issue and pull-request adoption after the remote accepts a write but the transport disconnects.
- Duplicate linkage-marker conflicts and pagination-origin containment.
- Permission classification without response-body retention.
- A temporary real Git repository proving forward and divergent histories; captured `updateRefs` inputs always use
  the exact `beforeOid` and `force: false`.

Recorded fixtures use only the synthetic `acme/repo` repository, synthetic node IDs, redacted request IDs, and
locally generated commits. They contain no live credential or GitHub response.
