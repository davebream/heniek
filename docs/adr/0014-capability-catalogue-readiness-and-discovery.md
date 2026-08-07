# 14. Durable provider-neutral capability catalogue

- Status: accepted
- Date: 2026-08-07
- Issue: davebream/heniek#16 (Q015, T2-capability, milestone M2)
- Spec anchors: §9 Accounts/workers/roles/profiles, §10.1 v1 engines, §15 Local control plane
- Evidence: [`evidence/0014-q015-capability-matrix.json`](evidence/0014-q015-capability-matrix.json),
  [`evidence/0014-q015-doctor-report.json`](evidence/0014-q015-doctor-report.json),
  [`evidence/0014-q015-command-results.md`](evidence/0014-q015-command-results.md)

## Context

Q014 validates profiles against injected provider-neutral rows, but it deliberately does not
discover those rows or decide whether an engine/account is currently usable. Heniek needs durable,
inspectable evidence for Claude, Codex, and Cursor without learning provider DTOs or directly
invoking their CLIs. Claudexor 3.1.2 at commit
`bb5efee24132aa3d65e417040df201e08da44c8c` is the sole runtime boundary.

## Decisions

### D1 — discovery crosses only the pinned Claudexor `/v2` operation catalogue

The adapter negotiates `/v2/handshake`, verifies the pinned engine identity and operation catalogue,
then reads agent capabilities, harness inventory, credential profiles, per-harness models, auth
readiness, and quota. Raw DTOs and provider identity fields are consumed inside the adapter and are
never returned, cached, or placed in public contracts. Resume and cancellation use a pin-specific
compatibility attestation that is activated only after the exact handshake succeeds; they are not
inferred from removed or unadvertised harness fields.

### D2 — readiness dimensions remain distinct

Every row reports configuration, installation, authentication, compatibility, capacity, freshness,
and final readiness independently. Unknown evidence stays unknown. Unknown capacity does not by
itself block readiness; a known active rate limit does. Account ids match Claudexor credential
profile ids exactly. Only accountless native Claude may use Claudexor's native-login authority.

### D3 — cache validated snapshots for two minutes

Migration 8 adds a SQLite cache keyed by engine, account, engine version, and Claudexor version.
Snapshots expire after 120 seconds. A lightweight pinned-API version probe runs before cache reuse;
a version change writes a distinct row and can never fall back to the older-version row. Partial
endpoint failures preserve successful sections with typed absence reasons; a failed refresh retains
only the prior compatible-version snapshot, explicitly marked stale with failed discovery provenance.

### D4 — authoring and execution apply different freshness policy

The pure Q014 `resolveProfile` API is unchanged. Additive wrappers translate catalogue models into
its existing rows, then validate required model, effort, mode, feature, and tool capabilities.
Authoring may use stale evidence with a warning while rejecting known incompatibilities. Execution
refreshes expired evidence and fails closed on stale, missing, unsupported, unknown, incompatible,
unauthenticated, or rate-limited required evidence.

### D5 — discovery is observable through existing control surfaces

The authenticated `engine.catalogue.v1` RPC is negotiated by result schema and used by
`heniek engine list [--refresh] [--json]`. Human output is a compact capability matrix. Doctor keeps
`DoctorReportV1` unchanged and appends stable runtime, authentication, compatibility, and readiness
checks for every discovered engine/account row.

## Consequences and boundaries

- All three v1 engines appear even when unconfigured or unavailable.
- Model provenance remains `api`, `manifest`, or `none`; feature evidence is never inferred from a
  model or provider name.
- No installation, login, credential mutation, provider recommendation, or direct provider-CLI
  integration is introduced.
- Account scheduling/fallback and engine execution adapters remain later backlog work.
