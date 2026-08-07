# 13. Deterministic account, worker, role, profile, and effort resolution

- Status: accepted
- Date: 2026-08-07
- Issue: davebream/heniek#15 (Q014, T2-capability, milestone M2)
- Spec anchors: §8 Configuration model, §9 Accounts/workers/roles/profiles, §10.1 v1 engines
- Evidence: [`evidence/0013-q014-resolved-profiles.json`](evidence/0013-q014-resolved-profiles.json),
  [`evidence/0013-q014-invalid-diagnostics.json`](evidence/0013-q014-invalid-diagnostics.json),
  [`evidence/0013-q014-command-results.md`](evidence/0013-q014-command-results.md)

## Context

The generic configuration layer resolver already supplied deterministic precedence, source
provenance, privacy rules, and allowlisted invocation writes. It did not understand the references
between a profile, worker, role, and account, and it had no capability input with which to reject an
unsupported model/effort/mode combination. Q014 adds that domain resolution without implementing
Q015's discovery catalogue or any execution adapter.

## Decisions

### D1 — validate the complete catalog after the first six layers merge

Individual layers may contain partial entity updates. The existing generic resolver merges them
first; the resulting `accounts`, `workers`, `roles`, and `profiles` sections are then validated
against `ProfileConfigurationV1`. This preserves field-level layering while ensuring no incomplete
entity can be selected for execution.

### D2 — invocation overrides are a typed seventh input, never a raw document

The selected profile's `overridable` list is not known until the first six layers resolve. The
profile resolver therefore rejects raw `invocation-override` documents, reads the selected
allowlist, validates a closed semantic override vocabulary, and applies only declared fields. This
prevents an arbitrary JSON pointer from bypassing the profile policy.

### D3 — capability validation is injected and fail-closed

Q014 accepts provider-neutral rows keyed by engine, optional account, model, efforts, and execution
modes. An absent exact row or an unsupported effort/mode is an error. No model names are inferred and
no static catalogue is shipped; Q015 will provide discovered rows through this interface.

### D4 — external execution names an account; native Claude inherits its parent

External workers require an account whose engine matches the resolved worker engine. Accounts carry
only a name, engine, and the v1 `subscription` billing route—never credential material. Native mode
is Claude-only, forbids an account on a declared native worker, and omits account/billing from the
resolved profile.

### D5 — provenance is semantic; fingerprints exclude source location

`ResolvedProfileV1` maps each effective runtime field back to the winning configuration pointer,
layer, source path, and overridden chain. Invocation winners are recorded as the seventh layer.
Values are redacted before snapshotting. The fingerprint is SHA-256 over canonical redacted v1
semantics with a domain separator; provenance, diagnostics, paths, and the fingerprint itself are
excluded, so relocating equivalent files does not change identity.

### D6 — execution request compatibility is additive

`ExecutionRequestV3` is V2 plus an inline `ResolvedProfileV1` shape. ExecutionRequest V1 and V2 are
unchanged byte-for-byte, and no existing backend interface switches versions in Q014.

## Consequences and boundaries

- Resolution is pure and returns a discriminated result. An error result cannot carry a profile, so
  callers must resolve before provisioning or mutating a workspace.
- Role instruction content remains outside this resolver; only the safe relative path and artifact
  contract are retained for the instruction-snapshot consumer.
- Engine discovery/readiness (Q015), provider adapters (Q016–Q020), account queues/fallbacks (Q021),
  and billing-route enforcement/process cleanup (Q022) remain deliberately out of scope.
