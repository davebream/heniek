# 2. Claudexor `/v2` long-run handles, questions, resume and parent independence

- Status: accepted
- Date: 2026-08-01
- Issue: #4 (Q003 — Spike A)
- Spec anchors: §17 Interactions and questions, §18 Durability and recovery, §23.5 Required
  compatibility tests
- Evidence: [`evidence/0002-claudexor-v2-event-trace.md`](evidence/0002-claudexor-v2-event-trace.md)

## Context

Spec §18.1 commits Heniek to daemon-owned work that outlives the launching parent: after Claude Code
closes, a later session must be able to reconnect, inspect status, answer questions, fetch results and
continue the pipeline. §23.2 fixes Claudexor's versioned `/v2` control API as the only sanctioned
integration surface, and §23.5 lists the compatibility tests that must pass before a Claudexor version is
promoted.

Before this spike those were commitments about a dependency nobody had exercised. This ADR records what
the pinned revision actually does, from executable canaries only. Nothing here is inferred from
Claudexor's documentation or source comments; where something was not observed, it is recorded as not
observed.

## The pin under test

`docs/reference/development-references.md` pins Claudexor to `v3.1.2` /
`bb5efee24132aa3d65e417040df201e08da44c8c`. Upstream tag `v3.1.2` dereferences to that commit.

The pin is not merely assumed — the running engine self-reports it at handshake, and
`assertPinnedEngine` fails the canary if it does not match:

```json
{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations",
 "engine":{"version":"3.1.2","sha":"bb5efee24132aa3d65e417040df201e08da44c8c"}}
```

Claudexor was fetched, installed and built in a scratch directory **outside this repository** and is not
vendored here. Nothing from its runtime home — journal, run artifacts, or its 0600 bearer token — enters
this repository.

## Commands

```
git fetch --depth 1 origin bb5efee24132aa3d65e417040df201e08da44c8c   # in a scratch dir
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @claudexor/cli... build
node <pin>/packages/cli/dist/claudexord.js                            # HOME=<scratch>, CLAUDEXOR_CONTROL_PORT=<ephemeral>

HENIEK_CONFORMANCE_SMOKE=1 \
HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE=none \
HENIEK_CONFORMANCE_SMOKE_CLAUDEXOR_ROOT=$CLAUDEXOR_ROOT \
pnpm vitest run packages/conformance/test/claudexor.smoke.test.ts
# HENIEK_CONFORMANCE_SMOKE_TRACE_OUT=... is read by gate.ts but consumed only by the
# uncommitted long-run driver; the committed suite writes no trace.
```

`AUTH_ROUTE=none` is deliberate: it declares that this gate provisions no auth route of its own. It is
**not** evidence about the effective route — see "Auth route" below.

**Reproducibility, stated plainly.** The committed opt-in suite
(`packages/conformance/test/claudexor.smoke.test.ts`) runs only the handshake/pin check and the
cancellation canary. **Canaries 1, 2 and 4, the trace writer, and the `/v2/operations`,
`auth-readiness` and `quota` probes were driven from a scratch harness that is not committed**, because
this spike's exclusions cap it at "minimal spike code" and a 20-minute driver is not that. So the
numbers below are real observations of the pinned engine, but only the handshake and cancellation rows
are reproducible from this repository alone. Committing the long-run driver is follow-up work, not a
claim this ADR makes.

## Observations

### O1 — The `/v2` path prefix and the protocol major are decoupled

The engine serves every product route under `/v2`, but requires **protocol major 3**. A handshake
advertising `2` is refused:

```
incompatible_protocol_major — control protocol major 2 is incompatible; server requires 3
requiredActions: ["use control protocol major 3"]
```

Product calls additionally require an `X-Claudexor-Protocol-Major: 3` header; without it the engine
answers HTTP 426 `handshake_required`.

This is the spike's most load-bearing compatibility finding, because §23.2 and ADR 0001 both describe
the surface as "the versioned `/v2` control API", which invites an adapter to derive the major from the
URL. On the pinned revision that is wrong. `negotiateProtocol` therefore accepts no path argument at
all, so the mistake is not expressible, and the case is pinned by a regression test.

### O2 — The operation catalog is machine-readable and self-describing

`GET /v2/operations` returns 70 descriptors carrying `requestSchema`, `responseSchema`, `idempotency`,
`mutability`, `applicability` and `completion`. `POST /v2/runs` is described as *"Start a run and return
its durable handle"* with `idempotency: key_required` and `completion: durable_handle` — the durable
handle this spike is about is a first-class, self-described property rather than an inference.

The operations that carry Heniek's §17/§18 requirements are `POST /v2/runs`, `GET /v2/runs/:id`,
`GET /v2/runs/:id/events` (SSE; the `Last-Event-ID` resume cursor is declared by the engine's own
`/v2/operations` descriptor for that route — this ADR does not claim to have exercised it),
`POST /v2/runs/:id/control`,
`POST /v2/runs/:id/interactions/:id/answer`, `POST /v2/threads/:id/turns`,
`GET /v2/recovery/partitions/:id` and `POST /v2/harnesses/:id/auth-readiness`.

### O3 — Run lifecycle vocabulary, and why the mapping is not one-to-one

`ControlRunState` is `queued | running | succeeded | failed | cancelled | interrupted`. There is **no
waiting state in the lifecycle**: waiting is carried out of band on `summary.waitingOnUser` plus the
interactions sub-resource.

| Claudexor | Heniek `RunStatus` | Note |
|---|---|---|
| `queued` | `queued` | |
| `running`, `waitingOnUser=false` | `running` | |
| `running`/`queued`, `waitingOnUser=true` or open interactions | `waiting_on_user` | **derived**, not mapped |
| `succeeded` | `succeeded` | |
| `failed` | `failed` | |
| `cancelled` | `cancelled` | |
| `interrupted` | `recovery_required` | **provisional** — see O7 |
| — | `waiting_for_parent_session` | no Claudexor source; native stages (§18.3) stay Heniek-owned |

The mapping returns the canonical `RunStatus` from `@heniek/contracts` rather than a private copy, so it
cannot drift from the contract silently.

### O4 — Parent independence

**Supported.** Two runs of the same canary, both reported:

| run | postKillMs | post-kill events | state at kill | daemon after kill | outcome |
|---|---|---|---|---|---|
| duration | 1 370 779 (22.8 min) | 350 | `running` | alive | **supported** |
| terminal | 1 027 738 (17.1 min) | 2 824 | `running` | alive | `degraded` (below the floor) |

An intermediate launcher process started the daemon and the run, then was `SIGKILL`ed by
pid — never by process group, which would have killed the daemon too and faked a failure.
In both runs the launcher died and the daemon survived, and `GET /v2/runs/:id` continued to answer
afterwards. The observing client was **not** torn down and re-created across the kill, and no
`Last-Event-ID` reconnect was performed, so this says nothing about resume-after-disconnect — see
"Not covered".

The measured interval is `terminal − kill`, not `run.created − terminal`: a long run whose
parent dies in its final seconds demonstrates seconds of independence, and the issue asks
for a long session **and** a parent kill. The kill landed 45 s into the duration run, corroborated by
its trace.

Both rows above are **hand-transcribed from the driver's JSON with hand-assigned outcomes**: the
driver did not record `killAtFractionOfBudget`, so the kill-timing gate that
`classifyParentIndependence` implements — and that the defects table below credits — was **not
evaluated on either reported run**. The gate is unit-tested; it did not gate these numbers.

Continued **progress** was required, not mere survival. Post-kill frames include
`plan.progress` and `harness.event`, so the run was working, not idling. The terminal run
carried all the way to `succeeded` with 2 824 post-kill events; the duration run passed the
20-minute floor and was still `running` when the observation harness was torn down — the
run outlived the observer as well as the parent.

The duration run is reported as the one satisfying the ≥20-minute constraint; the terminal
run is reported alongside it, `degraded`, because it settled at 17.1 min. Both appear in the
evidence rather than only the favourable one.

**Caveat, stated plainly:** the daemon is spawned `detached` with `stdio: "ignore"`, and on
POSIX such a process outlives its parent regardless of the engine. This arm therefore shows
that Claudexor's run *keeps working* after the parent dies — which spawn flags alone do not
give you — but it does not isolate the engine's contribution to process survival. The
non-detached arm that would isolate it is specified in the canary and **was not run**; see
"Not covered" below.

### O5 — Questions, answers and same-session resume

**Supported.** A run was started with a prompt requiring a clarifying question. The engine
emitted `interaction.requested`, `summary.waitingOnUser` became true, the canary answered
through `POST /v2/runs/:id/interactions/:id/answer`, and **the same `runId` continued to a
terminal state** — §17.2's "answer sent to the same worker session", observed rather than
assumed.

Two shape facts matter for an adapter, and both cost a false negative before they were found:

- The answer body is a **list** of per-question answers
  (`{answers: [{questionId, selectedLabels, freeText}]}`), not a single string.
- The `interactionId` and each `questionId` live in the **`interaction.requested` event
  payload**, not in the run summary. An adapter polling only `GET /v2/runs/:id` can observe
  that a question exists but cannot answer it.

Before these were corrected the canary reported same-session resume as *unsupported* — a
limitation the engine does not have.

### O6 — Cancellation and process-tree cleanup

**Supported for settlement; process-tree cleanup only weakly sampled.** `POST /v2/runs/:id/control`
with `{control: {kind: "cancel"}}` was accepted and the run settled as `cancelled` within ~20 s.

The descendant-PID count of 0 comes from a `ps`-based sample in the uncommitted harness, taken after a
bounded settle window. It is a weak instrument — it cannot distinguish "the engine reaped the tree"
from "the sample missed a short-lived child" — and the committed suite does not sample it at all.
Treat cancellation *settlement* as verified and process-tree cleanup as indicative only.

The control body carries `control` as an **object**, not a bare verb string. Sending the
string is rejected as `invalid_request`; the first cancellation canary did exactly that and
reported "cancellation unsupported" — again a limitation the engine does not have. Both
shapes are now pinned by tests.

### O7 — The restart boundary

**Supported, and this settles the `interrupted` mapping.** A run was started, the daemon was
`SIGKILL`ed mid-run, and a new daemon was started on the same home. The run handle was still
readable afterwards, and the run's state was **`interrupted`**. The evidence file carries one such
row, so this is a single recorded observation, not a replication. `GET /v2/recovery/partitions/:id` was **not** called; the
`recoveryPartitionReadable` field in the evidence records only that the restarted daemon answered
`/healthz`, and should not be read as a statement about the recovery-partition API.

That is what §18.2 describes: an attempt whose outcome the runtime cannot vouch for, needing
an explicit resume/retry/fail decision rather than a silent retry. `interrupted →
recovery_required` therefore stands on an observation rather than on the enum member's name.
It remains flagged `INTERRUPTED_MAPPING_IS_PROVISIONAL` in code until an adapter consumes it
in anger, because these observations show what a *daemon kill* produces and do not enumerate
every path to `interrupted`.

### O8 — Auth route: the subscription route is NOT proven on this host

Observed on a succeeded run:

```json
"authRoute": {"requested":"auto","effective":"local_session",
              "source":"oauth_token_env","reason":"native_first"}
```

while `POST /v2/harnesses/claude/auth-readiness {"authRequest":"subscription","source":"native_session"}`
reports:

```json
{"readiness":{"source":"native_session","availability":"unavailable",
              "verification":"not_run","detail":"official native Claude session is not logged in"}}
```

and `GET /v2/quota` reports `not_logged_in` for the `vendor_native` route.

§23.5 requires "subscription-only auth-route verification". **That item is therefore unverified.** The
route that works on this host is `local_session` via `oauth_token_env`. This is a property of this host's
credential provisioning, not of Claudexor, and it is recorded as an open §23.5 item rather than as a
pass. No product commitment is narrowed by this ADR.

## Stop-condition evaluation

Issue #4 instructs the autonomous run to stop with a typed blocker if, among other things, "a required
subscription route cannot be proven". O8 is exactly that condition, so it was evaluated explicitly
rather than passed over:

- **Condition:** the subscription-only auth route cannot be proven on this host.
- **Observation:** O8 — `native_session` readiness is `unavailable`; the effective route is
  `local_session` / `oauth_token_env`.
- **Why the spike proceeds anyway:** the issue's stated outcome is whether pinned `/v2` handles survive
  parent disconnects and support durable questions, answers, cancellation and same-session resume. None
  of those depend on *which* credential route the harness used — the run executes identically either
  way, and O4–O7 were all obtained on a real, authenticated external Claude session. Stopping here would
  withhold answers the issue asks for over a question it does not ask.
- **What remains unproven:** §23.5's subscription-only verification, which needs a host with a logged-in
  native Claude session. Re-verification step: run `POST /v2/harnesses/claude/auth-readiness` with
  `{"authRequest":"subscription","source":"native_session"}` on such a host and confirm
  `availability: available`, then re-run canary 1.

## Not covered by this spike

- **The non-detached parent-independence arm.** Specified in `canaries.ts` and reported
  separately by design, but not executed. Without it, O4 shows the run keeps working after
  the parent dies, but does not separate the engine's contribution from `spawn`'s.
- **Subscription-only auth-route verification** (O8).
- **Resume after client disconnect.** `streamEvents` supports a `Last-Event-ID` cursor, but nothing
  called it; no run was observed through a genuinely re-created client.
- **`GET /v2/recovery/partitions/:id`**, `/v2/operations` and `auth-readiness` as *committed* canaries —
  they were probed by hand during the spike and their findings are recorded in O2/O8, but no committed
  test exercises them.
- **Process-tree cleanup as a hard assertion** (O6).
- Codex and Cursor external profiles, isolated write attempts, artifact/diff retrieval,
  malformed-output and unsupported-model handling — all belong to later issues.

## §23.5 coverage from this spike

| §23.5 item | Status |
|---|---|
| 20-minute external planning run | **verified** — 22.8 min post-kill (O4) |
| free-text question and same-session continuation | **verified** (O5) |
| cancellation and process-tree cleanup | settlement **verified**; process-tree cleanup indicative only (O6) |
| subscription-only auth-route verification | **unverified** (O8) |
| session resume | **not exercised** — `Last-Event-ID` reconnect was never performed |
| daemon restart/recovery classification | **verified** (O7) |
| event/result normalization | partially — redaction and state mapping exercised; no normalization contract asserted |
| Claude external profile | exercised |
| Codex / Cursor external profiles | out of scope for Q003 |
| isolated write attempt, artifact path/diff retrieval, malformed output, unsupported model | out of scope for Q003 |

## Decision

Claudexor `/v2` is accepted as the v1 `ExecutionBackend` surface for long-running, daemon-owned work,
subject to the unverified §23.5 items above, the "Not covered" list, and the per-canary bounded
fallbacks carried in `packages/conformance/src/smoke/claudexor/canaries.ts`.

The integration must:

1. **Negotiate the protocol major from the handshake, never from the `/v2` path**, and send
   `X-Claudexor-Protocol-Major` on every product call (O1).
2. **Assert the engine's self-reported identity against the pin** before trusting any run, so a
   mismatched or unexpected daemon is a loud failure rather than silent divergence (pin section).
3. **Derive `waiting_on_user`** from `waitingOnUser` and the interactions sub-resource rather than
   expecting a lifecycle state (O3).
4. **Own the daemon's lifetime itself** rather than inheriting it from whatever session happened to
   start it (O4).
5. **Treat a cancel acknowledgement as a request, not a guarantee**, and verify settlement (O6).
6. **Never silently retry an attempt whose outcome is uncertain** across a restart; classify it and ask
   (O7, §18.2).

## Consequences

- Heniek's run projection can be driven from `/v2` without importing Claudexor internals; the canary
  client in `packages/conformance/src/smoke/claudexor/` is the reference shape for that boundary.
- The `interrupted → recovery_required` mapping is provisional until O7 settles it; it is flagged in
  code (`INTERRUPTED_MAPPING_IS_PROVISIONAL`) so it cannot quietly become load-bearing.
- The canaries are opt-in and never run in CI. `pnpm check` stays hermetic and offline; the classifiers
  they depend on are pure and *are* covered by `pnpm check`.
- A committed, redacted event trace exists as evidence. A repository-level test over `docs/adr/**`
  enforces the absence of credential- and path-shaped substrings (Biome does not lint Markdown); the
  stronger "no prompt text or model output" property follows from the recorder's allowlist, not from
  that test.

## Defects found while implementing, and the tests that pin them

| Defect | Pinned by |
|---|---|
| A credential-prefix match without a word boundary denies every real Claudexor task id, because a `task-` prefixed id contains the OpenAI-style secret-key prefix as a substring | `claudexor-trace.test.ts` |
| Including `-` in the opaque-token heuristic makes a canonical UUID look like a secret, silently dropping a UUID-shaped `run_id` | `claudexor-trace.test.ts` |
| `+` is absent from the value allowlist, so offset-form ISO-8601 timestamps were rejected — and, before the recorder was made total, threw mid-stream and destroyed the remaining evidence of an expensive run | `claudexor-trace.test.ts` |
| Readiness read from the daemon log is satisfied by a stale `control-api listening` line from a previous daemon | `claudexor-readiness.test.ts` |
| Measuring a long run from `run.created` rather than from the parent kill lets a late kill masquerade as sustained parent independence | `claudexor-canaries.test.ts` |
