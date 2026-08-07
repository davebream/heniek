# 15. External Claude profile adapter

- Status: accepted
- Date: 2026-08-07
- Issue: davebream/heniek#17 (Q016, T2-capability, milestone M2)
- Spec anchors: §9.5 Claude execution modes, §10.4 subscription profiles, §22 execution backend,
  §23 Claudexor control boundary

## Context

Q014 resolves a named account, worker, role, model, and effort. Q015 proves that exact selection is
currently executable. Neither establishes the external Claude control route. This decision adds that
route through the selected Claudexor 3.1.2 `/v2` API while retaining the Q012 V2 adapter unchanged.

## Decisions

### D1 — V3 is additive and profile-aware

`ExecutionBackendV3` starts from `ExecutionRequestV3`, which carries the fully resolved profile. V1
and V2 contracts and interfaces retain their existing behavior. Callers first use Q015's
`resolveProfileForExecution` with questions, resume, and cancellation requirements; stale or
unready evidence fails before a control request is made.

### D2 — external Claude is subscription-only

The adapter accepts only external Claude profiles with `billing: subscription` and a named account.
It sends the exact account as Claudexor's credential profile, sets `authPreference: subscription` on
both thread and turn creation, and supplies the resolved model and effort on each turn. Native,
account-less, non-Claude, and non-subscription profiles are rejected without fallback.

### D3 — the thread is Heniek's opaque durable execution identity

The stable Claudexor thread id is returned only as Heniek's opaque backend execution id. A resume
creates another turn in that thread using the retained resolved profile; it never creates an
independent session. Provider DTOs, credential values, control artifacts, and transcript data do not
cross the adapter boundary.

### D4 — lifecycle events are intentionally narrow

The V3 event feed accepts an opaque replay cursor and exposes only normalized status, typed
rate-limit delay, and typed terminal context-capacity exhaustion. Malformed frames and unrecognized
provider payloads are ignored rather than surfaced. Cross-engine usage and context measurements are
owned by Q019.

## Consequences and boundaries

- Fixture-backed V3 conformance covers subscription routing, interaction lifecycle delegation,
  cancellation, same-thread resume, replay, rate limiting, and non-leakage.
- Existing opt-in runtime canaries remain the execution environment for subscription and cleanup
  proof; this milestone creates neither a new CLI nor a checked-in credential/runtime artifact.
- Durable inbox behavior remains Q020 and generalized process/environment cleanup remains Q022.
