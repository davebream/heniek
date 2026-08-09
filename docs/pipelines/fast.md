# Bundled `fast` pipeline

Product default for lightweight execution tasks (Product Spec §30.1). Not a
runtime invariant — users may replace or extend stages freely.

## Intended use

- Shared deliberation (`task-owner`) producing understanding, design, and plan.
- Build with at most one identical-signature validation repair (`non_empty_diff`
  required).
- Optional fresh `reviewer` risk review when `risk.requiresFreshReview` is true.
- Deterministic verify from repository workspace policy argv checks.
- Publish through the forge backend.

Ordering follows §30.1 (risk review before verify). Spec §14.6 narrates the
opposite order; see [ADR 0028](../adr/0028-bundled-fast-pipeline-and-onboarding.md).

## Tradeoffs

| Choice | Tradeoff |
|---|---|
| Single builder profile for deliberate + build | Faster fusion/resume; less adversarial depth than `careful` |
| One bounded build repair | Stops unchanged validation loops; deep repair needs a different template |
| Conditional risk review only | Low-risk tasks skip a fresh session; high-risk tasks pay a cold start |
| Policy-driven verify | Argv is repository-local; no shell wrappers |

## Stage artifacts

| Stage | Writes |
|---|---|
| `deliberate` | `artifacts.understanding`, `artifacts.design`, `artifacts.plan` |
| `build` | `artifacts.implementation` |
| `risk-review` | `artifacts.risk_review` |
| `verify` | `artifacts.verification` |
| `publish` | `artifacts.publication` |

## Overrides

Bundled YAML under `packages/pipeline/bundled/` is immutable after install.
Overrides are copy-on-write into application-home (for example
`~/.heniek/codebases/<id>/pipeline-overrides/`). Q032 owns general override
precedence and one-off graph attachment; do not mutate the installed template.

## Evidence

- Template + hashes: [ADR evidence](../adr/evidence/0028-q030-bundled-fast-hash.md)
- Fake-backend scenario: [run export](../adr/evidence/0028-q030-fast-run-export.md)
- Decision record: [ADR 0028](../adr/0028-bundled-fast-pipeline-and-onboarding.md)
