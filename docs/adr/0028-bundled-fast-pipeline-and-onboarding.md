# 28. Bundled fast pipeline and agent-guided onboarding

- Status: accepted
- Date: 2026-08-10
- Issue: davebream/heniek#31 (Q030 — ship the bundled fast pipeline,
  T2-capability, milestone M3, closes it)
- Spec anchors: §14.6 Bundled pipelines, §30.1 `fast`, §19.5 Stage completion
  contract
- Evidence:
  [`evidence/0028-q030-command-results.md`](evidence/0028-q030-command-results.md),
  [`evidence/0028-q030-bundled-fast-hash.md`](evidence/0028-q030-bundled-fast-hash.md),
  [`evidence/0028-q030-onboarding-evidence.md`](evidence/0028-q030-onboarding-evidence.md),
  [`evidence/0028-q030-fast-run-export.md`](evidence/0028-q030-fast-run-export.md)

## Context

Q029 shipped segment fusion and smart continuation. Milestone M3 still required
a versioned bundled `fast` template with explicit artifacts, bounded repair,
optional risk review, deterministic verification, and publish — plus
agent-guided repository onboarding that can supply verify argv without shell
wrappers. Spec §14.6 narrates `fast` as verify-then-risk-review, while §30.1
lists risk-review before verify; the shipped template had to pick one ordering.

## Decision

### D1 — Bundled immutable template + generated ESM manifest

`packages/pipeline/bundled/fast.v1.yaml` is the human-authored source of truth.
Generation embeds the YAML, pins `sourceSha256` and `normalizedGraphSha256`, and
exposes `listBundledPipelines` / `getBundledPipeline` / `loadBundledPipeline`.
Installed templates are never mutated in place; overrides are copy-on-write into
application-home (Q032 owns general override precedence).

### D2 — §30.1 stage ordering over §14.6 narrative

§14.6's typical-behavior sketch places deterministic verification before
risk-triggered fresh review. §30.1's YAML lists `risk-review` before `verify`.
This ADR follows §30.1: after build, conditional `risk-review` (when
`risk.requiresFreshReview == true`) precedes `verify`, then `publish`. The §14.6
discrepancy is recorded here rather than silently merged.

### D3 — WorkspaceConfiguration/v2 and repository workspace policy

Onboarding persists `RepositoryWorkspacePolicy/v1` per repository and projects
it to `WorkspaceConfiguration/v2` (structured verify checks) while retaining a
v1 projection for callers that only need setup scripts. Verify stages resolve
argv checks from policy via `resolveVerifyChecksFromPolicy`.

### D4 — Onboarding propose/apply

`codebase.onboard.propose` runs an injected analyzer once (with one repair of
malformed drafts), digests the proposal, and stores it for review.
`codebase.onboard.apply` commits policies only when the expected digest matches.
Shell-wrapper argv patterns are rejected.

### D5 — Verify/publish write binding and policy-driven verify

Verify and publish runners bind declared stage `writes` (for example
`artifacts.verification`, `artifacts.publication`) to their result values so
§19.5 completion does not leave missing writes. Daemon compose resolves verify
checks from repository workspace policy when preparing verify stages.

### D6 — Build repair budget under identical-signature ceiling

ADR 0026 treats the repair budget as the unchanged-signature ceiling
(`identicalSignatureCount >= budget` exhausts). `fast` therefore sets
`max_repair_attempts: 2` (and build `on_validation_failure.max_attempts: 2`) so
one identical validation repair is allowed before exhaustion. Agent runners mark
`validation_failed` as runner-retryable so §19.6 strategies can apply.

## Consequences

- Operators get a loadable, hash-pinned `fast` path with optional risk review.
- Onboarding can seed verify argv without mutating the bundled YAML.
- Q031 (`careful`) and Q032 (overrides) build on the same bundled lookup and
  write-binding conventions.
- Callers must not assume §14.6's verify-before-risk ordering for `fast`.

## Commands

See [`evidence/0028-q030-command-results.md`](evidence/0028-q030-command-results.md).
