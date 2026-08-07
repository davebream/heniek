# 17. Cursor CLI execution and profile adapter

- Status: accepted
- Date: 2026-08-07
- Issue: davebream/heniek#19 (Q018, T0-evidence, milestone M2)
- Spec anchors: §10.1 v1 engines, §10.2 assisted engine management, §10.4 billing guard,
  §22 execution backend, §23.5 required compatibility tests
- Evidence: [`evidence/0017-q018-command-results.md`](evidence/0017-q018-command-results.md),
  [`evidence/0017-q018-redacted-trace.json`](evidence/0017-q018-redacted-trace.json)

## Context

Cursor is the third v1 engine (§10.1) and the only one whose runtime semantics were never
established: ADR 0003 recorded it as "not attempted", and `PINNED_COMPATIBILITY.cursor` carried
`resume: unknown` / `cancellation: unknown`. Because `startProfileExecution` requires `questions`,
`resume`, and `cancellation`, those two unknowns made every Cursor profile unstartable regardless
of configuration.

Q016 added the external Claude route and Q017 the native Codex route, both through Claudexor's
`/v2` API. This issue is tier `T0-evidence`, so a bounded spike had to resolve Cursor's
print/JSON/session semantics — resume in particular — before any adapter code was written. The
spike ran against Cursor CLI `2026.06.12-01-15-52-7244546` and a locally built Claudexor
`3.1.2` at `bb5efee24132aa3d65e417040df201e08da44c8c`.

## Decisions

### D1 — Cursor is a native-session route and never names a credential profile

`subscriptionProfileRoute` admits Cursor and returns `{ harness: "cursor" }` with no
`credentialProfileId`, structurally identical to Codex. This is not a naming preference. Claudexor's
INV-135 defines a Cursor credential profile as *exactly* an API-key secret ref and refuses any other
transport, so forwarding a resolved Heniek account as a credential-profile id would silently move
the run onto the metered API-key route that §10.4's billing guard forbids. A resolved Heniek account
may still identify the user's profile; it never crosses the adapter boundary.

Native, non-Cursor, and non-subscription profiles are rejected before any control traffic.

### D2 — native-session attestation is now harness-parameterized, and re-checked on resume

Q017's `codexNativeSessionAttested` became `nativeSessionAttested(harness)` over a
`NATIVE_SESSION_HARNESSES` set rather than gaining a third copy. All six comparisons remain
load-bearing: Claudexor echoes the request back, so checking only `readiness` would accept an answer
about a different harness or auth source than the one asked for.

Attestation runs after the handshake and before thread creation, and now also before every resume —
a session can be revoked or expire between the original turn and a follow-up. A refused resume
creates no turn. `diagnoseCursorAuthRoute()` reports `CURSOR_NATIVE_SESSION_ATTESTED` /
`CURSOR_NATIVE_SESSION_UNATTESTED`.

### D3 — the spike resolved resume, so compatibility is pinned on evidence

`--resume <sessionId>` continues the **same** session rather than forking one: two follow-up turns
returned the originating session id, and a large `cacheReadTokens` on the resumed turn confirms the
prior conversation was actually reloaded, not merely that an id was reused. Cancellation terminates
the run (launcher exits `143`). `PINNED_COMPATIBILITY.cursor` therefore moves from
`resume: unknown` / `cancellation: unknown` to `supported`, which is what makes a Cursor profile
selectable at all.

Because that pin feeds the catalogue, Q015's committed capability matrix now reports the new
states; `evidence/0014-q015-capability-matrix.json` was updated in the same change so the
drift guard keeps telling the truth.

### D4 — no contract or schema change

`cursor` was already a `ProfileEngine` literal, already in `ENGINE_VALUES`, `ENGINES`, the
`OPEN_MAP_KEY` provider-leakage denylist, the instruction dialects, and the migration-8 `CHECK`.
Cursor's observed frames map onto `ExecutionEventV2`'s existing kinds and its
`{inputTokens, outputTokens, cacheReadTokens}` onto `ExecutionResultV3.usage`, so no schema was
added, no version bumped, and no generated artifact changed.

### D5 — an empty successful result must not produce an empty summary

Cursor can terminate a run as `subtype: "success"` with an empty `result` and no assistant frame at
all; Claudexor's parser gates final text on a non-blank check and so emits neither a message nor an
error. `ExecutionResultV3.summary` requires `minLength: 1`, so the summary fallback now tests
**trimmed** length before accepting `finalSummary` or the error text, falling through to the typed
`Claudexor execution <status>.` default. A whitespace-only final would otherwise have satisfied the
schema while carrying no summary. Covered by a regression test.

## Consequences and boundaries

- Fixture-backed V4 conformance covers the Cursor subscription route, the no-credential-profile
  guarantee, pre-flight attestation failure, resume re-attestation, the empty-result shim, and the
  rejection matrix.
- **Billing guard.** With `CURSOR_API_KEY` removed from the environment, a headless run reports
  `apiKeySource: "login"` — the subscription session, not a key. Claudexor additionally sets
  `CURSOR_API_KEY: null` on the native route. Heniek never constructs the engine environment itself;
  its contribution is refusing the API-key route, which D1 enforces and a test pins.
- **The Cursor CLI auto-updates.** It replaced itself mid-spike and `PATH` now serves a newer build.
  Claudexor resolves the binary by bare name, so it inherits whatever `PATH` offers;
  `CLAUDEXOR_CURSOR_BIN` is the only lever that actually pins a build. This is in tension with
  §10.2's "never silently upgrades" and with `heniek engine pin cursor <version>`; pinning Cursor is
  left to the engine-management work, not solved here.
- **Claudexor detects the Cursor login by parsing prose** from `cursor-agent status` against a narrow
  grammar. It matches the pinned build, but a future Cursor build that reworded that line would
  silently drop the subscription route to `unavailable`.
- **The route is not attestable under scoped-HOME isolation.** Cursor's session is keychain-backed and
  read through the daemon's own `HOME`, so a daemon started with a scratch `HOME` — as the Claudexor
  canaries start one — reports `unavailable` even when the user is signed in. Production runs under
  the real `HOME`, which is the configuration proven here. A Cursor canary must not scope `HOME`.
- **A detached vendor process survives cancellation.** `cursor-agent` spawns a `worker-server` that
  re-parents to PID 1 and outlives a cancelled run by design. A cleanup canary asserting
  "descendants return to baseline" must exclude or explicitly kill it.
- Claudexor refuses `access: "full"` for Cursor as not conformance-proven; `readonly` and
  `workspace_write` are available.
- `questions` remains `unsupported` for Cursor, but so is it for Codex — both harnesses report
  `interactive: false`. That gating is pre-existing and shared, and durable inbox behavior remains
  Q020.
- Live thread/turn/resume/cancel through `/v2` for the cursor harness stays with the opt-in runtime
  canaries, as in ADR 0015; this milestone adds no new CLI and no checked-in credential or runtime
  artifact.
