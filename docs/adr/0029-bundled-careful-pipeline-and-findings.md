# 29. Bundled careful pipeline and immutable finding reports

- Status: accepted
- Date: 2026-08-10
- Issue: davebream/heniek#32 (Q031)
- Spec anchors: §19 Review and verification, §30.2 `careful`, §32 reference extraction
- Evidence:
  [`evidence/0029-q031-extraction-record.md`](evidence/0029-q031-extraction-record.md),
  [`evidence/0029-q031-careful-hash.md`](evidence/0029-q031-careful-hash.md),
  [`evidence/0029-q031-careful-run-export.json`](evidence/0029-q031-careful-run-export.json),
  [`evidence/0029-q031-command-results.md`](evidence/0029-q031-command-results.md)

## Context

Q030 established immutable generated pipeline bundles. Q031 needs the higher-assurance
`careful` workflow while keeping predecessor and TAKT concepts at development time.
Unstructured Markdown alone cannot safely drive conditional repair or preserve finding
identity across review, repair, and verification.

## Decision

### D1 — One atomic structured artifact per review stage

Review, repair, and final-verification stages each emit one versioned JSON artifact. The
artifact contains typed machine fields and its human-readable Markdown. Runtime validation
checks JSON shape, semantic combinations, lineage, finding identity, and verdict before the
stage may succeed. Accepted reports publish under their actual content schema.

### D2 — Immutable reports with a rebuildable projection

Every accepted report is stored once with its artifact ID and SHA-256 digest. A conflicting
reuse of a report ID is rejected. SQLite projects the latest disposition, claim verification,
repair, and resolution state per finding. The projection can be deleted and deterministically
rebuilt from immutable reports; it is never a second authority.

### D3 — Fresh review, owned repair, bounded retry

Critic, plan-reviewer, code-reviewer, and final-verifier stages start fresh. Designer and
builder repair stages resume their owning context. Plan validation fails closed through verdict
evidence. Code repair is conditional on derived actionable IDs and permits one retry under ADR
0026's budget-two identical-signature rule. Rejected/retracted findings never enter repair.

### D4 — Deterministic checks remain authoritative

The fixed verify stage runs before final verification. The final report must cite deterministic
check artifacts, and publication depends on both verify and a ready final-verification verdict.
An agent can interpret check evidence but cannot replace a failed check.

## Consequences

- Operators can query the current lifecycle without mutating evidence history.
- Schema evolution is explicit through checked-in public contracts.
- The product does not import Kombajn, TAKT, provider payloads, transcripts, or a cyclic manager
  runtime.
- A repair or verification report with unknown, rejected, or illegally transitioned findings is
  rejected before projection advancement.
