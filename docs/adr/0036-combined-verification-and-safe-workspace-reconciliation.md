# 36. Combined verification and safe workspace reconciliation

- Status: accepted
- Date: 2026-08-12
- Issue: davebream/heniek#45 (Q038, T2-capability)
- Spec anchors: §18 durability and recovery, §19 review and verification, §20.6 wave integration
- Evidence:
  [`evidence/0036-q038-combined-verification-report.json`](evidence/0036-q038-combined-verification-report.json),
  [`evidence/0036-q038-recovery-cleanup-trace.json`](evidence/0036-q038-recovery-cleanup-trace.json),
  [`evidence/0036-q038-command-results.md`](evidence/0036-q038-command-results.md)

## Context

Q035–Q037 provide composite workspaces, isolated variants, writer leases, expected-SHA integration,
whole-Codebase analysis, and task bindings. They intentionally stop before combined verification and
before a restart can decide whether an interrupted composite operation is safe to resume or clean.

Repository-local checks cannot be short-circuited when one repository fails: a failure in one root is
evidence about that root, not permission to hide the state of the others. Cleanup has the inverse safety
shape. It must stop at the first missing ownership proof, archive the available evidence, and preserve the
checkout for an operator.

## Decision

`CombinedVerificationReportV1` records one immutable fan-in report. The lifecycle service runs every
declared repository-local check and every whole-Codebase check, keeps argv, cwd, expected and actual exit
codes explicit, writes bounded command logs, and reports repository failures independently from a
whole-Codebase failure. Only failed required checks fail the combined result; optional checks remain visible.

Restart reconciliation is an ordered six-phase pass:

```text
provisioning → setup → leases → processes → artifacts → integration refs
```

Every phase requires exactly one observation. Verified Heniek-owned work may be confirmed, resumed, or
retried. Missing, ambiguous, externally owned, or unknown work is preserved and produces
`recovery-required`; the service never infers ownership from a terminal-looking state.

Cleanup is evidence-first. It archives the combined verification report, recovery trace, and additional
artifact/integration evidence before considering removal. A variant is removable only when all of these are
true:

- the operation is terminal;
- the checkout is verified as Heniek-managed and remains below its recorded workspace root;
- processes are absent or terminated and leases are absent or released;
- artifact and integration-ref ownership are both verified;
- restart reconciliation is complete;
- a successful operation has a combined verification report.

Adopted and user-owned checkouts are always preserved. Unknown ownership, an active resource, an incomplete
reconciliation, or archive failure prevents removal.

## Compatibility and boundaries

Three additive v1 schemas are registered: `CombinedVerificationReport`,
`WorkspaceRecoveryDecisionTrace`, and `WorkspaceCleanupResult`. Existing schemas and call sites are
unchanged. The lifecycle service is provider-neutral; it accepts only argv checks and phase observations,
and does not expose provider DTOs.

Q038 does not create the epic task DAG, schedule waves, ingest task-source revisions, or synchronize GitHub.
It supplies the combined verification and safe reconciliation primitives those later features can call.
