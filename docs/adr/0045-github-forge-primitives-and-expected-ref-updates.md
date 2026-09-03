# 45. GitHub forge primitives and expected-ref updates

- Status: accepted
- Date: 2026-09-03
- Issue: davebream/heniek#63 (Q047, T2-capability)
- Spec anchors: §21.5 draft pull-request default, §21.6 ForgeBackend abstraction, §21.7 cross-repository delivery
- Evidence:
  [`evidence/0045-q047-forge-conformance.md`](evidence/0045-q047-forge-conformance.md),
  [`evidence/0045-q047-requirement-traceability.md`](evidence/0045-q047-requirement-traceability.md),
  [`evidence/0045-q047-redacted-operation-trace.json`](evidence/0045-q047-redacted-operation-trace.json),
  [`evidence/0045-q047-command-results.md`](evidence/0045-q047-command-results.md)

## Context

The V1 forge contract could create a pull request, mark it ready, observe checks, and enable auto-merge.
It could not create or adopt issues and branches, return post-mutation observations, fence updates with an
expected remote version, or report mergeability. Q048 and Q049 need those primitives without learning GitHub
payload shapes or persisting provider state inside a registered repository.

GitHub REST issue updates do not expose an atomic conditional `PATCH`. Reading an ETag and then patching still
leaves a race with a concurrent human edit. REST ref updates likewise do not accept an expected old SHA.
GitHub GraphQL `updateRefs`, however, accepts `beforeOid`, `afterOid`, and `force`, and applies the requested ref
updates atomically.

## Decision

`ForgeBackendV3` additively extends V2. It exposes provider-neutral issue, ref, branch, pull-request, and
pull-request-status primitives. Mutations return `created`, `adopted`, `updated`, or `unchanged` together with a
fresh remote observation. Existing V1 and V2 signatures and generated schemas remain unchanged.

Every mutable observation carries an opaque SHA-256 version over canonical provider-neutral fields. Pull-request
metadata and status have separate versions: check completion must not invalidate a draft or auto-merge update.
Branch writes use the expected SHA directly rather than a derived version.

GitHub branch creation and update use GraphQL `updateRefs`. Creation sends the zero OID as `beforeOid`; update
sends the caller's expected head; both send `force: false`. A pre-read provides fast idempotent recovery, but the
server-side compare-and-swap is authoritative. Unexpected or non-fast-forward refs are surfaced as `stale_ref`.

Issue and pull-request creation append a hidden marker containing only a SHA-256 digest of the caller's
idempotency key. The adapter searches all relevant remote states before creation and after an ambiguous transport
failure. Exactly one marker with matching identity and desired content is adopted. Missing matches cause creation;
duplicates or mismatched content are conflicts. Raw keys, credentials, provider responses, and local runtime state
are never persisted.

Issue updates pre-read the expected observed version, patch only requested fields, then re-read and verify the
desired projection. If the initial version differs, the operation conflicts unless the remote resource already has
the requested state. Because GitHub offers no atomic conditional issue patch, a concurrent write between the read
and patch can be detected by the verification read but cannot always be prevented. This limitation is explicit
rather than presented as compare-and-swap.

Pull-request ready/draft transitions, auto-merge, mergeability, merge state, and required checks use GraphQL.
Auto-merge passes the caller's `expectedHeadOid` and defaults to squash because the inherited V1 contract has no
merge-method input. New pull requests default to draft when `draft` is omitted.

The HTTP transport moves to `@heniek/github-client` and is compatibility-re-exported by the GitHub task-source
package. The forge adapter receives separate read and write transports plus a repository locator. GitHub DTOs,
GraphQL documents, marker syntax, and composite pull-request identifiers stay inside `@heniek/forge-github`.

## Permissions and failure handling

The intended fine-grained token permissions are Metadata read, Contents read/write for refs, Issues read/write,
and Pull requests read/write. Required-check observations use GraphQL `statusCheckRollup` and `isRequired`; the
adapter does not request repository Administration permission.

Authentication, permission, not-found, rate-limit, stale-ref, conflict, malformed-response, and transport errors
are typed. Errors retain only bounded classification metadata such as a request ID and retry delay. Response bodies
and credentials are not attached to thrown values.

## Compatibility and boundaries

Fifteen additive schemas are checked in and pinned by the compatibility suite. The fake forge and recorded GitHub
adapter run the same 18-case conformance catalogue. Q047 does not choose materialization modes, adopt unmanaged
branches, coordinate multi-repository delivery, run CI repair loops, or wire credentials into the daemon; those
remain Q048/Q049 and later scope.

References:

- [GitHub GraphQL Git objects and `updateRefs`](https://docs.github.com/en/graphql/reference/git)
- [GitHub GraphQL pull requests](https://docs.github.com/en/graphql/reference/pulls)
- [GitHub REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
