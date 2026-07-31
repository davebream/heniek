# @heniek/conformance

A provider-neutral conformance test suite for the three backend contracts
defined in `@heniek/contracts`: `ExecutionBackend`, `TaskSource`, and
`ForgeBackend`. The shared case catalogue under `src/cases/**` is written
once against `ConformanceHarness<TSubject, TArrangement>` and is driven
against every subject — the bundled in-memory fakes, the opt-in subprocess
smoke adapter, and any third-party adapter — without change.

## Implementing a harness

The only interface a new backend must implement is `ConformanceHarness`
(`src/contract/harness.ts`). Its TypeScript shape only proves the type is
right; the case catalogue additionally assumes several behavioural
obligations the type alone cannot express. An implementation that satisfies
the type but violates one of these will fail cases, sometimes obscurely:

1. **`arrange()` targets the *next* run, not the current one.**
   `ConformanceSubject.arrange(arrangement)` configures the precondition for
   whichever run the *following* `start()` call creates. Every case calls
   `arrange()` (when it needs to) strictly before `start()`. There is no
   supported way to arrange a precondition onto a run that already exists
   through the harness-level API.

2. **`start()` must validate its own request and reject a
   contract-invalid one.** `execution/start-rejects-contract-invalid-request`
   and its siblings pass a structurally invalid request and require
   rejection — `start()` may not trust its caller.

3. **Progress is poll-driven, never wall-clock-driven, and the poll budget
   is fixed at 32.** The shared `pollUntil` helper
   (`src/cases/execution-backend.ts`) calls `status()` up to `MAX_POLLS = 32`
   times back-to-back, with no delay between calls, and throws an explicit
   poll-exhaustion error if its predicate is never satisfied within that
   budget. A subject whose progress depends on real elapsed time (a timer, a
   background tick) will never reach its target state within the budget and
   fails loudly rather than passing vacuously.

4. **`status()` advances at most one phase per call.** Cases that assert on
   an intermediate non-terminal status between `start()` and a terminal state
   depend on each poll moving the subject forward by exactly one step.

5. **An arranged `injects-fault` is delivered on the *first* `status()`
   call, not on `start()`.** The bundled fakes' fault programme is consumed
   inside `status()` (and the other per-operation methods); `start()` never
   consumes it. A harness that instead injects the fault synchronously
   during `start()` will desynchronize every case that arranges a fault and
   then polls for it.

6. **The per-operation fault taxonomy is fixed, not implementation-chosen,
   and `classifyFault` is the sole arbiter of every fault case.** An unknown
   reference (unknown run id, interaction id, pull request id, …) must
   classify as `"stale_ref"`; an operation called after the subject has
   already reached a terminal state must classify as `"conflict"`.
   `classifyFault(error)` is where an implementation maps its own error
   shape onto this vocabulary (`FaultKind | "unknown"`,
   `src/contract/fault.ts`) — the bundled fakes throw `ConformanceFaultError`
   directly, but a third-party adapter is free to throw whatever it
   naturally throws and classify it in `classifyFault` instead. Every case
   that checks a specific fault (via the case-context `expectFault` helper,
   `src/runner/case-context.ts`) compares `classifyFault`'s return value
   against the fault the case expects, so `classifyFault` must return
   `"unknown"` for any error unrelated to the fault taxonomy above — routing
   an unrelated error to a `FaultKind` would corrupt that comparison instead
   of failing it cleanly.

7. **`cancel()` followed by `result()` must synthesize a `cancelled`
   `ExecutionResultV1`.** A subject need not have a "real" terminal result to
   report after cancellation; it must still return a contract-valid result
   with `status: "cancelled"`.

8. **Trace actor/action labels, if recorded, must use the shared constants.**
   Recording is never required — the shared catalogue only asserts on a
   subject's return values and thrown errors — but a subject that populates
   `ConformanceContext.trace` must use `TRACE_ACTORS` /
   `EXECUTION_BACKEND_TRACE_ACTIONS` (`src/contract/harness.ts`), never an
   implementation-specific name, so a trace-inspecting case stays portable
   across every implementation of a family.

### Capabilities: the honesty mechanism, not a checklist to maximize

`ConformanceCapability` (`src/contract/capability.ts`) enumerates every
capability any case in the catalogue can `requires`: `lifecycle`,
`interaction`, `resume`, `cancellation`, `malformed-response`, and the five
`fault-*` capabilities (`fault-disconnect`, `fault-rate-limit`,
`fault-stale-ref`, `fault-conflict`, `fault-crash-recovery`). A harness
declares the subset it genuinely honours in `ConformanceHarness.capabilities`.

- **Declaring fewer capabilities never silently skips coverage.** Each
  catalogue case that `requires` a capability the harness does not declare
  is registered as `it.skip(...)` with the missing capability named directly
  in the test title (`describeFamily` in `src/runner/vitest.ts`) — a skip is
  always attributable to a specific, named, missing capability, never a
  silent pass. The bundled subprocess smoke adapter is a deliberate example:
  it declares `["lifecycle", "interaction", "cancellation",
  "malformed-response", "fault-stale-ref"]` and omits `resume` and every
  other `fault-*` capability, because a real child process has no
  fault-injection or crash-recovery axis to honour
  (`src/smoke/subprocess-execution-backend.ts`).
- **Declaring a capability you cannot honour is a failure, not a skip.**
  If a case calls `arrange()` with an arrangement whose capability the
  harness *declared* but cannot actually deliver, the harness must throw
  `UnsupportedArrangementError` (`src/contract/fault.ts`) — a
  declared-but-unhonoured capability is exactly the silent coverage gap the
  capability mechanism exists to prevent.
- **The three bundled fakes declare every capability their own family's
  catalogue requires and nothing more.** `test/fakes.conformance.test.ts`
  pins this with `missingCapabilities(...)` equal to `[]` for each fake, so
  the fakes' own conformance suite never skips a single case; and
  `test/matrix.test.ts` separately asserts that every capability a subject
  declares is required by at least one case of its own family (declaring an
  unused capability is itself a caught defect) and that every catalogue case
  is covered by at least one subject.
- **Capabilities drive the generated matrix, not the other way round.**
  `buildConformanceMatrix()` (`src/matrix.ts`) derives a `covered` /
  `opt-in` / `unsupported` cell for every `(case, subject)` pair purely from
  each statically declared subject's `family`, `availability`, and
  `capabilities` compared against each case's `requires` — the same
  `missingCapabilities` check `describeFamily` uses at runtime. It never
  executes the suite, so the generated matrix is a pure function of
  committed source.

## Opt-in smoke environment variables

The smoke suite (`test/smoke.conformance.test.ts`) is opt-in and no-op by
default — CI never spawns a subprocess or reaches the network unless
explicitly asked to.

- `HENIEK_CONFORMANCE_SMOKE` — must be exactly `"1"` to enable the suite.
  Unset (or any other value) resolves to an explicit `describe.skip(...)`,
  not a silently vanished suite.
- `HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE` — required when the suite is
  enabled; must be one of `"subscription"`, `"api_key"`, or `"none"`
  (`SMOKE_AUTH_ROUTES`, `src/smoke/env.ts`). A missing or unrecognised value
  throws, naming only the variable and the allowed values — never the
  observed value.
- `HENIEK_CONFORMANCE_SMOKE_MODULE` — optional. When unset, the bundled
  subprocess adapter runs (real process spawn, real stream framing, real
  SIGTERM cancellation, no network, auth route `none`). When set, it names
  an external adapter module dynamically `import()`ed and must export
  `createExecutionBackendHarness()` (`SmokeAdapterModule`,
  `src/smoke/harness.ts`). Because this value drives a dynamic `import()`,
  it is validated before use
  (`validateSmokeModuleSpecifier`, `src/smoke/env.ts`) and only two forms
  are accepted: a bare package specifier (`name` or `@scope/name`,
  optionally with a `/subpath`), or a path (relative or absolute) that
  resolves inside the repository root. Anything else — a
  `file:`/`data:`/`http:`/`https:` URL, a `../` escape, or an absolute path
  outside the repository — is rejected with an error that never echoes the
  rejected value.

## Generated artifacts

`generated/conformance-matrix.json`, `generated/conformance-matrix.md`, and
`generated/failure-replay.json` are derived, not hand-written:

```bash
pnpm --filter @heniek/conformance generate        # regenerate
pnpm conformance:check                            # verify committed artifacts are current (--check)
```

`conformance:check` is wired into the root `pnpm check` pipeline
(`package.json`). `generated/**` is declared `text eol=lf` in
`.gitattributes` so a Windows checkout with `core.autocrlf=true` cannot
rewrite these files' line endings and fail the byte-comparing `--check`.

## Running the suite

```bash
pnpm --filter @heniek/conformance test                                              # fakes + skipped smoke describe
HENIEK_CONFORMANCE_SMOKE=1 HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE=none pnpm --filter @heniek/conformance test  # + subprocess smoke
```
