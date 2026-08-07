# ADR 0011 — First Claudexor vertical slice

## Decision

Heniek exposes a provider-neutral `ExecutionBackendV2` beside the unchanged V1
contract. A V2 execution is addressed by an opaque backend handle; pending
interactions group individually answered questions; terminal results list
opaque artifacts; and `ExternalStageResult/v1` binds one summary to one safe
relative artifact path.

The first adapter targets only Claudexor's `/v2` control API and pins
`v3.1.2` at `bb5efee24132aa3d65e417040df201e08da44c8c`. It validates protocol major
3 and the required operation catalog before use. The stable Claudexor thread
ID is the backend execution handle. Observation resolves that thread's current
head run, while resume creates a turn on the same thread. Thread and turn
creation use deterministic idempotency keys derived from durable Heniek input.
Claudexor payloads, credentials, and transcript-shaped data do not cross the
adapter boundary.

Before calling the backend, the daemon creates a durable stage-execution row
and provisions a Q011 managed workspace. It persists the backend thread handle
before returning the Heniek run ID. Recovery always observes that handle and
never substitutes the Heniek run ID. A missing handle is retried through the
same deterministic start key.

On success, Heniek validates the declared path, byte length, and optional
SHA-256 descriptor, publishes the bytes to its immutable artifact store, and
atomically completes the stage and run. Import projections and finalization are
idempotent. Restart repairs a crash after atomic completion but before import
bookkeeping. Every succeeded, failed, or cancelled path releases the managed
workspace lease.

The bounded RPC/CLI surface is `stage start`, `run status|answer|resume|cancel|result`,
`artifact get`, and `doctor`. Artifact reads are chunked below the negotiated
NDJSON frame limit and verified end to end by length and SHA-256.

`doctor` reports runtime availability, Q004-isolated subscription-route
attestation, `/v2` compatibility, and durable cleanup state. It never installs
or upgrades Claudexor and never falls back to an API key. A failed check exits
nonzero; warning-only health remains successful but degraded.

## Consequences

- V1 contracts and generated schema digests remain unchanged; V2 additions are
  compatibility-tested as additive artifacts.
- Installation lifecycle, profile resolution, additional providers, and
  multi-stage graphs remain outside Q012.
- Deterministic conformance runs without credentials. Real promotion still
  requires an explicitly configured prebuilt pinned runtime and a
  `CLAUDE_CODE_OAUTH_TOKEN` accepted by both Claude and Claudexor's readiness
  route.
- Real conformance subsequently passed with the prebuilt pinned runtime and an
  OAuth subscription carrier; the redacted command transcript and trace are
  recorded in the adjacent evidence directory.
