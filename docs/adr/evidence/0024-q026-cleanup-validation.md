# Q026 — cleanup and evidence-validation report

## Cleanup

Command timeout/cancel sends `SIGTERM` to the process group, waits a bounded
grace period, then escalates to `SIGKILL`. The cleanup report records:

- `signalSequence` (`SIGTERM`, optionally `SIGKILL`)
- `descendantsRemaining` (must be `0` when `cleaned` is true)
- `gracePeriodMs`
- `cleaned`

Real subprocess coverage lives in `packages/runner/test/command.test.ts`
(descendant that ignores the first signal; cancel escalates; no process remains).

Daemon restart without a live runner handle classifies the attempt as
`recovery_required` (`observe_backend` / `reap_process` / `manual`) rather than
success. `reportRunnerCleanupHealth` summarizes open attempts and unclean
process groups.

## Evidence validation

`validateStageCompletion` rejects success when:

- any declared `writes` reference lacks a binding;
- a required result envelope is missing or contract-invalid;
- a completion requirement lacks matching satisfied evidence;
- the only evidence present is an exit code (`exitCodeAlone: true`).

Verdict requirements consume already-recorded verdict evidence only — they do
not invoke Q027 verify-stage behavior.
