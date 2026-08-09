# 21. Native Claude bridge — session-bound parent attach, dispatch, and submission

- Status: accepted
- Date: 2026-08-09
- Issue: davebream/heniek#24 (Q023 — Spike G, T0-evidence, milestone M2, closes it)
- Spec anchors: §6 execution modes, §9.5 attempts and retries, §17.1/§17.3 interactions and
  questions, §18.2 recovery and fail-closed defaults, §18.3 durable pipelines wait rather than
  silently switch profile, §22 public contract naming
- Evidence:
  [`evidence/0021-q023-command-results.md`](evidence/0021-q023-command-results.md),
  [`evidence/0021-q023-bridge-sequence-trace.md`](evidence/0021-q023-bridge-sequence-trace.md),
  [`evidence/0021-q023-stage-lifecycle-conformance.md`](evidence/0021-q023-stage-lifecycle-conformance.md)

## Context

A native profile means the *parent Claude Code session* spawns a subagent through its own Agent
tool. `packages/execution-claudexor/src/backend.ts` deliberately throws `unsupported_profile` for
it, because §6 states this as a structural fact, not a limitation to engineer around: the daemon
cannot call another process's Agent tool. It can only wait for a parent to connect and hand it
work.

`waiting_for_parent_session` already existed in `RunStatus` before this issue, legal in every
generated wire schema, and deliberately absent from `ExecutionStatus` (the backend-facing
vocabulary) — pinned by `packages/conformance/test/claudexor-state-map.test.ts`. Nothing had ever
produced it. This issue builds the missing half: a session-bound bridge where a connected parent
attaches, claims dispatched native work, mediates questions, and submits a result that passes the
same stage contract external execution does.

**Not in scope:** the Claude Code plugin itself (Q050). This issue delivers the daemon-side
bridge, the contracts, and the client calls Q050's plugin will consume, plus a canary that drives
the entire daemon-side protocol exactly as a plugin will.

## The pin under test

Unlike prior spikes in this series, no external engine is pinned here. **The pin is the Agent-tool
boundary itself** — the claim that the daemon cannot execute a native subagent, only admit,
dispatch, mediate, and settle work for one that connects. That claim is spiked against the real
assembled daemon (`startDaemon`, the exact composition root that binds the Unix socket and
publishes the serving record in production) over a real socket, with real HMAC-signed frames, a
real git worktree, and a real content-addressed artifact store — not a fake registry or an
in-process fixture standing in for the wire.

## Commands

```sh
pnpm --filter @heniek/contracts generate
pnpm --filter @heniek/contracts generate:check
pnpm --filter @heniek/conformance generate:check
pnpm typecheck
pnpm exec vitest run \
  packages/conformance/test/contracts-compatibility.test.ts \
  packages/conformance/test/claudexor-state-map.test.ts \
  packages/conformance/test/stage-lifecycle.test.ts \
  packages/state/test/migration-11-native-bridge.test.ts \
  packages/state/test/native-bridge.test.ts \
  packages/state/test/regressions.test.ts \
  packages/state/test/scheduling.test.ts \
  packages/state/test/complete-stage-derived.test.ts \
  packages/daemon/test/native-bridge-service.test.ts \
  packages/daemon/test/native-bridge-binding.test.ts \
  packages/daemon/test/native-bridge-rpc.test.ts \
  packages/daemon/test/no-ambient-sources.test.ts
pnpm check
```

Full results in [`evidence/0021-q023-command-results.md`](evidence/0021-q023-command-results.md).

## Observations

### O1 — `run_projection.status` has no `CHECK` constraint

The headline acceptance criterion — "an admitted native stage with no attached parent transitions
the run to `waiting_for_parent_session`" — needed an *emitter*, not a schema change. The vocabulary
already lived in contracts and is validated by the reducer against `RunStatus.values`; migration
11 is pure `CREATE`, nothing rebuilt, and no existing table is widened.

### O2 — `execution_attempt`'s `UNIQUE (run_id, candidate_index)` makes native retry unrepresentable

A native retry is "a new attempt," never a "guaranteed hidden-context continuation" of the same
attempt (§9.5). The existing scheduled-execution attempt table has no slot for that: its unique key
is a *candidate index* within one admission decision, not an ordinal across repeated dispatch
cycles. `native_stage_attempt` is a dedicated table keyed by `(run_id, attempt_ordinal)` for exactly
this reason — confirmed directly in the canary evidence, where a corroborated detach produces
`attemptOrdinal: 2` against the same run.

### O3 — `account_queue_entry.account_id` is `TEXT NOT NULL`

Native profiles have no account by construction (`profile.native-account-forbidden`) — there is no
capacity resource to queue against. Reusing the scheduled-execution admission path for native work
would have required inventing a placeholder account, which is exactly the kind of load-bearing
fiction D1 (below) exists to avoid.

### O4 — `interaction_record.run_id REFERENCES stage_execution(run_id)`

A native run has no `stage_execution` row, so native questions could not reuse the existing
interaction tables without a foreign key that is always unsatisfiable for them. `native_stage_question`
/ `native_question_projection` are separate tables for exactly the reason Q021 built
`scheduling_capacity_question` separately — same shape, different owner. The **contracts** are reused
verbatim (`PendingInteractionV2` in, `InteractionV2` / `InteractionAnswerSubmissionV2` out): no
native-only question schema exists, so a question raised by a native subagent reaches
`inbox.list.v1` and is answered through `run.answer.v2` exactly like any other, confirmed in the
canary trace.

### O5 — the 64 KiB line cap forces file-based artifacts

`MAX_LINE_BYTES = 64 * 1024` on every NDJSON frame rules out sending artifact bytes over the wire
at all for anything but the smallest files. The subagent writes into the assigned worktree; the
daemon reads, digests, and publishes it server-side (D7). This is strictly stronger than the
external path, which trusts backend-reported bytes without independently reading them from disk.

### O6 — the per-connection replay window dies with the connection

`nativeStage.poll.v1`'s `resumes[]` is delivered exactly once per session and marked delivered in
the same transaction (`native_question_projection.delivery_state`). A client that opens a fresh
connection per call (D6) cannot rely on a socket-level retry to re-request a delivery it missed —
the fencing tuple, not the connection, is the unit of correctness. Confirmed in the service-level
suite (`native-bridge-binding.test.ts`): a resubmission is judged by `submissionId` and digest, not
by connection identity.

### O7 — the CR1 interleaving is real, not a theoretical race

Adversarial review during planning produced a concrete data-corruption path: a parent sleeps past
its lease → attempt A1 goes to `recovery_required` → an operator resumes → attempt A2 is dispatched
and running → the original parent wakes and rebinds A1 (the guard passes, because the run is
non-terminal *precisely because A2 is running*) → it submits a stale result for A1 while A2 is
still in flight. Every one of the seven fenced fields (`sessionId`, `sessionRevision`,
`dispatchId`, `expectedDispatchRevision`, `runId`, `stageId`, `attemptId`) is legitimately correct
at submit time — the race is not caught by any single-field check. This is closed by making expiry
poison the *dispatch*, not just the attempt (D-CR1, below), and reproduced as a regression at three
independent layers: the store (`native-bridge.test.ts`), the service with a real second worktree
(`native-bridge-binding.test.ts`), and cross-checked against the declarative
`STAGE_LIFECYCLE_TRANSITIONS` table (`stage-lifecycle.test.ts`).

## Stop-condition evaluation

1. **The Agent-tool leg cannot be exercised.** No plugin exists yet — Q050 builds it. The canary
   (`packages/daemon/test/native-bridge-rpc.test.ts`) drives the entire daemon-side protocol exactly
   as a plugin will: real socket, real signed frames, real worktree, real published artifact. The
   Agent-tool invocation itself is recorded under "Not covered," not faked — the same posture ADR
   0002 took for its uncommitted long-run driver.
2. **A reviewer demands widening `ExecutionStatus`.** Did not occur. `waiting_for_parent_session`
   stayed exclusively `RunStatus`-owned throughout, and
   `checkNoExternalMapperOwnsWaitingForParentSession` (new in this issue) makes that a checkable,
   reusable invariant rather than a one-off assertion.
3. **Cross-mode fallback judged in scope.** Did not occur. `stage.start.v3` rejects a native
   primary declaring `fallbackProfileIds` outright (`native-fallback-unsupported`), confirmed by a
   dedicated test in `native-bridge-service.test.ts`.

## Not covered by this spike

- **The Agent-tool invocation itself.** Q050's job. This issue proves everything up to and
  including "the daemon handed a real subagent a real worktree, prompt, and instructions path, and
  correctly processed whatever came back over the wire" — never that a Claude Agent tool call
  actually happened inside the canary.
- **`nativeStage.status.v1` surfacing an artifact id.** The wire result carries `summary`/
  `artifactPath` (the same `ExternalStageResult/v1` shape external execution uses) but no
  `artifactId` list the way `run.result.v3` does for scheduled runs. The canary reads it via a
  second, independent connection to the daemon's own state file — legitimate (it is exactly what
  `artifact.get.v1`'s own handler does internally) but not an RPC-only proof. Tracked as follow-up,
  not part of this issue's RPC surface.
- **Long-poll.** `nativeStage.poll.v1` is immediate-return with a `pollAfterMs` hint (D6). A
  bounded long-poll `poll.v2` is additive future work, not attempted here.
- **Multi-parent arbitration beyond rebind.** Two parents racing to attach to the same codebase is
  covered (second session's poll sees nothing to claim, its submit against the first session's
  dispatch is rejected); two parents racing to *rebind the same session* simultaneously is not
  separately exercised.
- **Claude Code plugin surface (MCP tools, slash commands, UX).** Q050.

## §22 naming and secrecy-boundary coverage

| Requirement | Status |
|---|---|
| No public field begins `claude\|codex\|cursor\|github\|anthropic\|openai` | **verified** — enforced by a guard test in `packages/conformance/test/contracts-compatibility.test.ts` (unchanged, extended by the new schema count) |
| No field looks credential-shaped | **verified** — same guard test |
| Session/dispatch-id secrecy is defense-in-depth only, never a security boundary | **stated explicitly below** |
| Committed ADR/evidence contain no real path, credential, or non-synthetic identifier | **verified** — `packages/conformance/test/claudexor-trace.test.ts`'s redaction guard scans every `docs/adr/**/*.md`, including this file and its evidence |

## Decisions

### D1 — dedicated `NativeBridgeService`, not an `ExecutionBackendV7` adapter

Four independent blockers rule out reusing the scheduled-execution adapter shape: returning a
`BackendExecutionHandle` for undispatched work is exactly the pretence §6 forbids;
`waiting_for_parent_session` coming from a backend would break the pinned `ExecutionStatus`
exclusion and a dozen schema digests; `account_queue_entry.account_id` is `NOT NULL` while native
has no account by construction (O3); and `execution_attempt`'s unique key makes a native retry
unrepresentable (O2). `packages/daemon/src/runtime/native-bridge-service.ts` is therefore a
standalone service sitting beside `SchedulingExecutionService`, not inside it — reused where the
underlying capability genuinely is shared (`@heniek/workspace`'s provisioning, D2's terminal path),
duplicated in a handful of small private helpers (`repositoryHead`, `safeArtifactPath`,
`workspaceConfiguration`) where sharing would create a cross-service coupling for eight lines of
code.

### D2 — one shared terminal path

`packages/daemon/src/runtime/stage-completion.ts`'s `finalizeStageArtifact()` is the one place
either execution mode finishes a stage — `ExecutionService.finalizeSuccess`,
`SchedulingService.finishTerminal`, and the native bridge service's `submit()` all call it. This is
what "native results pass the same stage contract" concretely means, and it closed a real,
pre-existing asymmetry: `SchedulingService.finishTerminal` never validated `ExternalStageResultV1`
before this issue; `ExecutionService.finalizeSuccess` always did.

### D3 — fencing, no bearer token

The daemon has one flat capability: `daemon.local-control`. Any holder can already call
`run.answer`/`run.cancel` on anything, so a bridge-specific token would stop no attacker that
fencing does not already stop. **Session and dispatch-id secrecy is defense-in-depth only, never a
security boundary** — the actual boundary is possession of that single credential, exactly as for
every other authenticated method. "Rebinding cannot submit to the wrong run/stage/attempt" is a
concurrency property, not an authorization one, and is enforced by CASing the full seven-field
tuple inside single SQLite transactions (`validateDispatchFence` in
`packages/state/src/native-bridge/store.ts`), never by whether the caller happened to know an id.

### D4 — client-minted `submissionId`, server-computed digest

`submissionId` is the idempotency key (matching `execution_operation_outbox.operation_id`'s
existing precedent) because it answers "same intent?", which a payload digest cannot. The digest
itself is *not* client-supplied at the wire layer: `nativeStage.submit.v1`'s handler
(`packages/daemon/src/runtime/compose.ts`) computes it from the canonicalized
`outcome`/`result`/`failure` payload before calling the service, so a same-`submissionId` retry
with genuinely different content is caught (`idempotency_key_reuse`) without trusting the caller to
compute an honest digest of itself.

### D5 — typed `rejectionCode` results, never thrown errors — with one stated exception

`dispatchFrame` collapses every handler throw into a bare `-32603` with no `data`, so a thrown
refusal is indistinguishable from a daemon bug. Every native-bridge method except
`parentSession.attach.v1` returns `{accepted: false, rejectionCode}` instead. **Existence and
ownership collapse into one code** (`unknown_dispatch`) so a rejection response is never a
cross-session enumeration oracle — confirmed directly: a second session's poll never sees another
session's claimed dispatch, and a submit against it is indistinguishable from a submit against a
dispatch that never existed.

`parentSession.attach.v1` is the one exception, and it is deliberate: `ParentSessionAttachmentV1`
carries no rejection wrapper in the pinned contract, because a rebind mismatch on *attach* is a
genuine caller error (the caller is asserting its own prior state), unlike poll/question/submit,
which race against staleness as a routine, expected part of the protocol.

### D6 — immediate-return poll with `pollAfterMs`, no long-poll in v1

One connection per RPC call (each client call in `@heniek/client` opens a fresh socket and re-runs
`hello`+`negotiate`), a 64-connection cap, and drain closing sockets under an in-flight poll all
argue against holding a connection open. Collapsing heartbeat, claim, answer-delivery, and
revocation into one `poll` call is itself deliberate for the same reason in reverse: four separate
methods would cost four socket setups per cycle and could never see one atomic daemon-side
snapshot. Shipping `pollAfterMs` now makes a future `poll.v2` long-poll purely additive.

### D7 — artifacts never cross the wire

The 64 KiB line cap (O5) forces this, but it is also strictly the more honest design: the daemon
reads the file the subagent wrote, digests it, and publishes it itself, rather than trusting
backend-reported bytes the way the external path does. Verified end to end in the canary: the
published artifact's SHA-256 and byte length are read back through `artifact.get.v1` and compared
against the literal bytes written into the worktree.

### D8 — `SchedulingDecision/v2`

`recordDecision` (`packages/state/src/scheduling/store.ts`) has always been able to write
`user_choice`, `attempt_succeeded`, `attempt_cancelled`, and `attempt_recovery_required` — none of
which were in `SchedulingDecisionV1`'s 14-literal union, which is typed `string` at the column
level with no `CHECK`. The daemon could already return a payload violating its own published
schema before this issue. Fixed by minting a new schema version rather than widening the existing
one in place (no digest ever changes after publication): `SchedulingDecision/v2` cascades to
`StageRunStatusResult/v4` and `StageRunResult/v3` (`run.status.v4`, `run.result.v3`), registered
*alongside* the still-live v3/v2 endpoints, not replacing them.

### CR1–CR9 — the concurrency-correctness properties this issue closes

Found and confirmed during adversarial review before implementation, then verified empirically —
not just reasoned about — via the CR1 regression at three layers (O7). Summarized; full detail in
`packages/state/src/native-bridge/store.ts`'s own comments at each site:

- **CR1** — expiry poisons the *dispatch* (state → `abandoned`, revision bumped), not only the
  attempt, closing the interleaving in O7.
- **CR2** — every mutating call CASes the stage's current-attempt pointer, not just the run.
- **CR3** — submit is one synchronous transaction with no `await` between artifact-bytes-read and
  the fencing CAS; artifact publication happens strictly after settlement, using the store's
  `requiresArtifactCompletion: true` signal so the daemon-side service (not the store) performs the
  filesystem/git work the store package cannot.
- **CR4** — inner, non-nesting transaction variants (mirroring the scheduling package's own
  `applyCapacityAnswerInside`/`cancelQueuedInside` pattern) let submit atomically settle the
  dispatch and complete the attempt in one transaction.
- **CR5** — reap-on-read runs inline at the start of every mutating bridge call, calling the same
  `reapExpirations` function a background timer also calls — never two implementations of the sweep.
- **CR6** — three-valued liveness (`alive`/`dead`/`unknown`) via an injected `WitnessClassifier`.
  `alive` never expires the attempt (session merely "stalled"); `dead`/`unknown` both route to
  `recovery_required`, with `unknown` additionally revoking the dispatch permanently. All leases are
  treated as expired on daemon boot.
- **CR7** — one fencing token: `attach` always mints a brand-new `sessionId`; there is no separate
  epoch column two tokens could disagree about.
- **CR8** — a graceful detach's "never started" claim is corroborated, not trusted: any
  daemon-checkable evidence of work (a raised question, a staged artifact) routes the dispatch to
  `recovery_required` instead of back to the redispatch pool.
- **CR9** — claims are scoped by `codebase_id` and use `changes === 0` after an `INSERT ... ON
  CONFLICT DO NOTHING`, never a caught `SQLITE_CONSTRAINT` — matching D5's "typed result, not a
  thrown error" discipline all the way down to the row level.

## Consequences and boundaries

- A native run is now first-class: `stage.start.v3` is the one admission door for every profile,
  routing by the resolved profile's `executionMode` and reporting back which mode it took, so a
  caller never pre-decides "native or external" by method name. Its status may legitimately be
  `waiting_for_parent_session` — a native stage started with nobody connected is admitted and
  waits, which is §18.3's "the durable pipeline waits rather than silently switching to an external
  profile" made concrete.
- **Session scoping is routing and correctness, not authorization.** Stated in D3 and repeated
  here because it is easy to over-claim: possession of `daemon.local-control` remains the only
  security boundary this bridge has or needs. Dispatch-id secrecy narrows what a legitimate holder
  of that credential can accidentally race against; it does not, and is not meant to, keep out
  anyone who does not already hold the credential.
- **Heniek can declare a working directory to a native subagent but cannot enforce the parent's
  cwd.** What it keeps is the same honesty ADR 0020 already applied to its own workspace boundary:
  a post-hoc read-only git-state comparison (`workspace_mutated`, verified by re-checking the
  captured baseline immediately before accepting a succeeded submission) plus the artifact
  contract — a semantic git-boundary guarantee, not a claim of an OS sandbox.
- The three existing conformance families (provider-adapter contracts) are untouched. The bridge is
  not an adapter, so no fourth family, no new generated matrix entry, and `conformance:check` stays
  exactly what it was — `packages/conformance/src/stage-lifecycle/` is a pure, ungenerated module
  checked by its own flat test file.
- `RUN_STATUS_V4_METHOD` and `RUN_RESULT_V3_METHOD` (the D8 cascade) are additive: v3/v2 remain
  registered and negotiable, so no existing client breaks.
- A daemon configured with only the native bridge — no scheduling, no legacy execution backend — is
  now a genuinely supported shape (D1's whole point), not merely a theoretical one: `inbox.list.v1`,
  `artifact.get.v1`, `run.answer.v2`, and `run.cancel.v1` are each registered whenever the native
  bridge alone is configured, not only when a scheduling or legacy execution backend also is.

## Defects found while implementing, and the tests that pin them

| Defect | Pinned by |
|---|---|
| `markExecutionFinalized` had no one-shot guard — a bare `WHERE run_id = ?` with no `changes` assertion let two completions silently overwrite each other | `regressions.test.ts` (`R-Q023-F1`) |
| `SchedulingService.finishTerminal` never validated the stage contract, unlike `ExecutionService.finalizeSuccess` | closed structurally by D2; regression coverage in `scheduling.test.ts` |
| `recordDecision` could write four decision kinds outside `SchedulingDecisionV1`'s union, with no `CHECK` to catch it | `scheduling.test.ts`'s decision-kind enumeration test, closed by D8 |
| `raiseNativeQuestion` inserted the question projection with a placeholder `last_event_sequence` before the backing journal event existed, violating its own foreign key | `native-bridge.test.ts` |
| Reap's "alive" branch bumped the session's own fencing revision, which would have invalidated a merely-late session's *own* next call | `native-bridge.test.ts` |
| `validateDispatchFence` rejected an already-`submitted` dispatch unconditionally, making D4's idempotent-replay path in `settleNativeDispatch` unreachable | `native-bridge.test.ts` |
| `cancelNativeStage` always reported `{status: "cancelled"}` even when the run had already independently settled as succeeded or failed | `native-bridge.test.ts` |
| Migration 11's causal-update trigger required a real journal event behind every `native_question_projection` write, which broke poll's "deliver the resume inline, no new event" design until a fourth event type (`native_question.delivered`) was added | `migration-11-native-bridge.test.ts`, `native-bridge.test.ts` |
| Two call sites derived the reap sweep's codebase from the caller-supplied `runId` instead of the session, which crashed on a deliberately-mismatched fencing test instead of returning a typed rejection | `native-bridge.test.ts` |
| The `workspace_mutated` rejection code was declared in the contract but never implemented — surfaced by an unused-import lint warning, not a failing test | `native-bridge-binding.test.ts` |
| `Value.Check` on `nativeStage.question.v1`/`nativeStage.submit.v1`'s request schemas threw `TypeDereferenceError` — their `Type.Ref` fields need the referenced schema passed explicitly; Ajv resolves the same `$ref` transparently at codegen time, which is why this never surfaced before a real RPC call exercised it | `native-bridge-rpc.test.ts` |
| TypeBox's `Value.Check` does not validate `format: "date-time"` unless a checker is registered, and no request schema validated through the daemon's dispatcher had ever carried one before `PendingInteractionV2.requestedAt` — every well-formed request would have been rejected as malformed | `native-bridge-rpc.test.ts` |
| `inbox.list.v1`, `artifact.get.v1`, `run.answer.v2`, and `run.cancel.v1` were each registered only inside the scheduling- or legacy-execution-configured branches, so a native-bridge-only daemon (a deployment shape D1 explicitly enables) could raise a question but never see it in its inbox, answer it, fetch the resulting artifact, or cancel the run | `native-bridge-rpc.test.ts` |
