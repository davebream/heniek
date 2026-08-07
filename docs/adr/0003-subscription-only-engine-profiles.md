# 3. Subscription-only Claude Code and Codex engine profiles under a hostile ambient environment

- Status: accepted; Codex broker decision superseded by Q017
- Date: 2026-08-01
- Issue: davebream/heniek#5 (Q004, `T0-evidence`, milestone M0)
- Spec anchors: §9.1 Accounts, §10.4 Billing guard, §27.4 Secrets and logs
- Evidence: [`evidence/0003-subscription-isolation-matrix.md`](evidence/0003-subscription-isolation-matrix.md)

## Context

### Q017 supersession — Codex is a native Claudexor session

The Codex-specific broker assumption in this ADR is historical evidence from
Q004, not a requirement for Heniek users. Q017 verified Claudexor's versioned
`/v2` control API attests a Codex `native_session` backed by the user's saved
ChatGPT login. Heniek now selects that route directly through its replaceable
execution backend and never requires, launches, or distributes a
`heniek-codex` credential runner. The old broker observations remain below as
an audit record for Q004; they must not be used as current runtime guidance.

§9.1 commits Heniek to running each external engine on a named subscription credential, and
forbids a `subscription_only` run from ever silently falling back to an API key. §10.4 requires the
runtime to **fail** rather than silently change billing mode. §27.4 forbids credential values from
ever reaching logs or committed artifacts. Before this issue those were commitments about a
mechanism nobody had built: nothing in this repository constructed an isolated child-process
environment for an engine, and nothing attested which billing route a run actually used.

The issue's own constraints shape what "proof" can mean here: no metered API request is allowed
(so no committed test can ever confirm a credential is *valid*, only that it is *present* and
correctly *shaped*), and no factory runtime state, credential store, or transcript may enter this
repository. The only two provider-visible signals available under those constraints are `claude
auth status --json` and `heniek-codex login status` — both offline, local diagnostics.

**This ADR was revised after the initial build**, once new empirical evidence (the N-series
observations below) showed the initial implementation had modelled Codex's credential carrier
incorrectly. See "Stop-condition evaluation" for the full account of that correction, and the
design artifact's §2 N-series table for the raw observations.

## The pins under test

`claude` 2.1.220, `codex-cli` 0.146.0 (surfaced through this project's `heniek-codex` broker CLI).
Neither diagnostic issues a model request. The credential/environment observations recorded as
scenarios A–G below were collected against these pins before this build began and are recorded here
as already-obtained facts, exactly as this issue's planning artifact transcribed them. The N1–N3
observations were collected during this build, after the initial implementation surfaced a modelling
question about how Codex's credential is actually carried; they are reproducible from a fresh clone
only in the same sense as A–G — they need an installed, pinned CLI/broker and an authenticated
subscription session on the observing host. What **is** reproducible from this repository alone, by
`pnpm check`, is everything built on top of those facts: the isolation recipe, the classifiers, the
redacted diff renderer, and every regression test below.

## Commands and results

```
HENIEK_CONFORMANCE_SMOKE=1 \
HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE=subscription \
HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION=1 \
pnpm vitest run packages/conformance/test/subscription.smoke.test.ts
```

`AUTH_ROUTE=subscription` is a deliberate divergence from ADR 0002, which declares `none` for the
Claudexor gate because that gate provisions no auth route of its own. This gate does: it constructs
an environment whose entire purpose is to carry a named subscription credential, so declaring `none`
would have been the wrong opt-in. The flag remains a *declaration of intent* and is never evidence
about the effective route — that is what `classifyClaudeBillingRoute` /
`classifyCodexBillingRoute` exist to attest, from the diagnostic, not from an opt-in flag. Any other
declared route disables this suite with a reason rather than throwing, because it is the wrong
opt-in, not a malformed one.

`HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT` may additionally name a
scratch directory **outside this repository** for the Claude arm's transient config home (the Codex
arm no longer takes a config home at all — see the Decision section); nothing from it enters this
repository, for the same reason nothing from `..._CLAUDEXOR_ROOT` does.

Everything except the opt-in smoke file runs unconditionally in `pnpm check`:

```
pnpm vitest run packages/conformance/test/subscription-variables.test.ts \
  packages/conformance/test/subscription-attestation.test.ts \
  packages/conformance/test/subscription-canaries.test.ts \
  packages/conformance/test/subscription-gate.test.ts \
  packages/conformance/test/subscription-probe.test.ts \
  packages/conformance/test/subscription-environment-diff.test.ts \
  packages/conformance/test/subscription-evidence-drift.test.ts
```

**Results, recorded verbatim (not narrated).** This ADR does not itself claim a specific `pnpm
check` outcome — the orchestrator that runs the commands above fills in what actually happened,
so this document cannot silently drift from what was observed:

`pnpm check`, from a clean checkout on Node.js 24.18.1 / pnpm 11.13.0, exit code 0:

```
Test Files  26 passed | 3 skipped (29)
     Tests  446 passed | 6 skipped (452)
```

The opt-in canary, run with the three variables above against the live `claude` 2.1.220 and
`heniek-codex` (`codex-cli` 0.146.0) diagnostics, exit code 0:

```
Test Files  1 passed (1)
     Tests  2 passed (2)
```

The 3 skipped test files and 6 skipped tests in the `pnpm check` figures are the repository's
opt-in real-engine suites (Q002's smoke conformance, Q003's Claudexor canaries, and this issue's
`subscription.smoke.test.ts`), which are disabled by construction without their gate variables.
That is why the canary line is reported separately: it is the same file, run opted in.

## Observations

The design artifact's grounded observation table records scenarios A–G, run with `claude auth
status --json` and `heniek-codex login status` against ambient environments ranging from
untouched-and-hostile through fully isolated. Five findings drive this design; each is now
represented by a named classifier condition and at least one regression test.

### O1 — `authMethod` alone is not an attestation (F-1; scenarios D, E5)

A subscription route (`authMethod: "oauth_token"`) and a visible ambient API key
(`apiKeySource: "ANTHROPIC_API_KEY"`) can be reported in the **same** diagnostic. The only
discriminator between "this run is on the subscription" and "this run might silently use the
visible key instead" is whether `apiKeySource` is present at all. `classifyClaudeBillingRoute`
therefore classifies an `oauth_token` session with a visible `apiKeySource` as `indeterminate`, not
`subscription` — an honest "cannot tell", not a guess in either direction.

### O2 — a provider-routing variable silently changes the billing route (F-2; scenarios E3, E4)

`CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX` move `apiProvider` away from `firstParty`
while `loggedIn` stays `true`. Neither variable is credential-shaped, so a defence-in-depth pattern
built only to catch `*_API_KEY`/`*_TOKEN`/`*_SECRET`-shaped names would never catch them. They are
therefore named explicitly in each engine's `hostileCatalogue` in
`packages/conformance/src/smoke/subscription/variables.ts`, and `classifyClaudeBillingRoute` checks
`apiProvider !== "firstParty"` **before** it ever inspects `loggedIn`.

### O3 — with no carrier present, an ambient API key becomes the effective route (F-3; scenario G3)

When the isolated environment carries no subscription carrier at all, an ambient API key is not
merely denied — it becomes the diagnostic's effective, reported route
(`authMethod: "api_key"`). This is exactly what §9.1 forbids. `buildIsolatedEnvironment` closes this
off at the source for a `carrierKind: "environment"` engine (Claude): it refuses to build any
environment at all when the declared carrier is absent or empty (`IsolationViolationError`), so this
scenario can only be reached by a caller that bypasses the recipe, and `classifyCredentialLifecycle`
separately reports `carrierPresent: false` combined with `route: "api_key"` as `unsupported` if it is
ever observed downstream anyway.

### O4 — the diagnostic is offline and cannot attest validity (F-4; scenario G1)

A fabricated, never-issued carrier token still reports `loggedIn: true` through this diagnostic.
The diagnostic attests credential **presence and shape**, never validity — expiry and revocation are
not observable without a provider round-trip, which this issue's "no metered request" constraint
forbids. `AttestationValidity` therefore carries `"presence_only"` on every attestation this issue's
code can produce; `"provider_verified"` exists in the type only so a later issue that adds a metered
check can extend this without a breaking change, and nothing in this issue emits it.

### O5 — an honest negative (F-5; scenarios E1, E2)

`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` produce **no observable change** in this diagnostic.
A guard that validates by reading the diagnostic back cannot detect either variable, so they cannot
be excluded "by observation" — there is nothing in the diagnostic to observe. They are excluded **by
construction** instead: `buildIsolatedEnvironment` never copies the ambient environment, so a
variable that is not a declared carrier, config-home variable, or neutral variable is never admitted
regardless of whether its effect is visible to this diagnostic at all.

### N1 — Codex needs no environment carrier and no caller-supplied config home

`heniek-codex login status`, run under a minimal environment consisting of ONLY `PATH` and `LANG`,
printed `Logged in using ChatGPT`, exit 0. No credential variable of any kind, and no config-home
variable, was present. This directly falsifies the assumption behind the original implementation's
`carrierKind: "environment"` model for Codex — Codex's subscription is not carried by anything this
recipe needs to name as an environment variable.

### N2 — Codex is immune to hostile ambient values, including a poisoned config home

The same minimal environment, plus hostile `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`,
`CODEX_HOME` and `HOME` (all sentinel values), still printed `Logged in using ChatGPT`, exit 0. The
broker replaces the child environment wholesale and provisions the saved ChatGPT auth document into
a config home **it owns** — the caller neither supplies nor can influence that home. This is
credential **retention**, not merely exclusion of the ambient value: the broker's own home wins
regardless of what the caller's environment claims.

### N3 — Claude requires `HOME`

The recipe environment `PATH`, `LANG`, `HOME=<configHome>`, `CLAUDE_CONFIG_DIR=<configHome>/.claude`,
`CLAUDE_CODE_OAUTH_TOKEN` printed `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}`,
exit 0. The SAME environment with `HOME` omitted exited **1** with **empty stdout** and an internal
stack trace on stderr (an `ENOENT ... uv_os_homedir` failure). `CLAUDE_CONFIG_DIR` alone is not
sufficient; `HOME` alone is. This was a genuine gap in the original `configHomeVariables` list for
Claude (see "Defects discovered while implementing" below) — it did not include `HOME`, which meant
an isolated Claude environment built by the original code would have failed the diagnostic outright,
while also risking a multi-kilobyte internal stack trace reaching whatever consumed the probe's
stderr.

### N4 — the two engines' diagnostics carry their status line on different streams

Collected after the opt-in canary suite (`subscription.smoke.test.ts`) was run for real by the
orchestrator for the first time: the Claude arm passed; the Codex arm failed with
`SubscriptionRouteViolationError: codex billing route is not subscription-only (route="indeterminate")`.
Diagnosed by running each diagnostic under the recipe environment (`PATH` = the fixed
`ISOLATED_PATH`, `LANG`) and capturing stdout and stderr separately.

- **N4a** — `heniek-codex login status` exited **0** with **`stdout` empty (0 bytes)** and
  `stderr = "Logged in using ChatGPT\n"`. The broker relays the underlying engine's output back over
  its own socket bridge, and that relay surfaces on the **stderr** stream, not stdout.
- **N4b** — `claude auth status --json` exited **0** with an **85-byte JSON document on stdout** and
  `stderr` empty (0 bytes).

`probeCodexBillingRoute` classified Codex from stdout only (mirroring the Claude branch), which N4a
shows is empty for Codex — the canary attested `indeterminate` for a live, logged-in ChatGPT
subscription, not because the subscription was absent, but because the classifier was reading the
wrong stream. This is exactly the class of defect the issue's own constraint anticipates: "prove
billing route from provider-visible identity or CLI diagnostics, not process exit alone." Both the
logged-in (N4a) and the not-recognised case exit 0 for the Codex command, so the exit code carries no
billing-route information at all — the relayed text is the only signal, and it is not on the stream
one would assume. `classifyRawDiagnostic` now classifies Codex from the **combined** stdout+stderr
text (see "Defects discovered while implementing" below), while Claude's stdout-only read is
unchanged (N4b: Claude's diagnostic is JSON on stdout, and mixing a stderr stack trace into a JSON
parse would be strictly worse).

## Decision

The recipe in `packages/conformance/src/smoke/subscription/variables.ts` is accepted as the v1
mechanism for constructing a subscription-only child-process environment, subject to the "Not
covered" section below. The mechanism must:

1. **Build the child environment from `{}` by explicit allowlist decision, never from a copy of
   `ambient`.** This is the only construction that can exclude O5's invisible variables at all, and
   it is what makes an unenumerated future hostile variable fail closed by default rather than by
   having been anticipated.
2. **Model two distinct carrier kinds, not one (`VariablePolicy.carrierKind`).** Claude is
   `"environment"`: a named environment variable is the carrier, checked and admitted by this
   module, and the module fails closed (`IsolationViolationError`) when it is absent or empty.
   Codex is `"brokered"`: the `heniek-codex` broker owns credential provisioning entirely (N1, N2);
   this module builds only a minimal allowlisted invocation environment for Codex and refuses
   (`IsolationViolationError`) if a caller supplies a `configHome` for it, since naming one would
   misrepresent where the credential actually lives.
3. **Include every config-home variable a diagnostic actually needs.** For Claude that is both
   `HOME` and `CLAUDE_CONFIG_DIR` (N3) — `CLAUDE_CONFIG_DIR` alone silently produces a hard failure
   with an unredacted internal stack trace on stderr.
4. **Fail closed (`IsolationViolationError`) when a `carrierKind: "environment"` engine's declared
   subscription carrier is absent or empty**, rather than returning a "logged out" style environment
   a caller could still run. §10.4 requires failing, not silently changing billing mode, and a
   returned-but-empty environment is exactly the silent path O3 demonstrates. A present-but-EMPTY
   declared carrier is recorded with its own `denied-empty-carrier` outcome rather than the generic
   `denied-unlisted`, so the redacted diff records *why* a name was excluded rather than requiring a
   reader to infer it from `presentInAmbient` plus a generic denial.
5. **Require `apiKeySource`'s absence, not `authMethod` alone, to attest `subscription`** (O1), and
   **check `apiProvider` before `loggedIn`** (O2), in that order — both pinned by classification-order
   regression tests.
6. **Never emit `validity: "provider_verified"`** from any diagnostic this issue can observe (O4).
7. **Exclude `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` by construction** rather than relying on
   detecting their effect (O5).
8. **Classify Codex login-status text by stable, disjoint-in-practice substrings, ambiguity-safe by
   construction** — a text matching more than one pattern classifies `indeterminate` rather than
   trusting a fixed check order to resolve the conflict, since the disjointness of the patterns is
   itself an unverified assumption (only the ChatGPT-subscription phrasing was ever actually
   observed).
9. **Interpolate only shape-validated values into any attestation `detail` string.** `bounded()`
   accepts only an environment-variable-name shape or a small closed set of expected
   `authMethod`/`apiProvider` values; anything else — regardless of what characters it contains —
   becomes the fixed literal `<unexpected-value>`. `apiKeySource` is checked against the same
   env-var-name shape at parse time in `parseClaudeAuthDiagnostic` — a value that is structurally not
   a string is still a genuine parse failure (`MalformedClaudeDiagnosticError`), but a string that is
   merely not env-var-name-shaped (e.g. a credential-prefixed value) is *sanitised* to the fixed
   literal `<unexpected-value>` rather than thrown, so classification and `assertSubscriptionOnly`
   can still run and fail closed instead of the caller losing the whole attestation to an aborted
   parse. Either way, a credential-shaped value can never reach `exposedKeySources`, a `detail`
   string, or a thrown `SubscriptionRouteViolationError`'s message.
10. **Render every markdown table the same way, with bounded cell length.** `renderEnvironmentDiff`
    and `toMarkdownTable` share one escaping function (`escapeMarkdownTableCell`): `|` is escaped,
    `\r\n`/a lone `\n`/a lone `\r` are all collapsed to a single space (a bare `\r` alone can still
    make some terminals overwrite a line in place), and an oversized cell is truncated to a fixed
    length rather than left free to inflate committed evidence or a CI log.
11. **Never let an attacker-controlled ambient `PATH` decide which binary a bare-name `execFile` call
    resolves to.** `PATH` is declared in every engine's `hostileCatalogue`, but is never simply
    denied: `buildIsolatedEnvironment` always admits it first, with a dedicated `"admitted-fixed"`
    outcome and a fixed constant (`ISOLATED_PATH`) — never the ambient value, for either engine.
    `probe.ts`'s `execFile("claude", ...)` / `execFile("heniek-codex", ...)` calls a bare command
    name, which Node resolves against the child process's `PATH`; before this, an ambient `PATH`
    prepending an attacker-controlled directory could make either call silently resolve to a
    different binary than the one this recipe intends to invoke.

`assertSubscriptionOnly` is the fail-closed gate a caller must run before treating any attestation as
authorization to proceed: it throws unless the route is unambiguously `subscription` **and** no key
source is reported as visible. `buildIsolatedEnvironment`, a probe, and `assertSubscriptionOnly` are
three separate calls a caller composes; nothing in this issue enforces that composition at the type
level — see the §10.4 coverage note below for what that does and does not mean.

## §9.1 / §10.4 / §27.4 coverage from this issue

| Spec item | Status |
|---|---|
| §9.1 — a `subscription_only` run may never silently fall back to an API key | Verified **for the hermetic classifiers and the recipe's fail-closed construction**, and by regression test (O3 / G3). No product runtime consumes this recipe yet, so nothing is verified about an actual Heniek run. |
| §10.4 — the runtime must fail rather than silently change billing mode | **Corrected claim** (see below) — verified only for the composition convention, not as a universal "only two outcomes" guarantee. No product runtime consumes this yet. |
| §27.4 — no credential value in logs or committed artifacts | Verified **by construction** (`VariableDecision` and `BillingRouteAttestation` never carry a value; `bounded()` and the `apiKeySource` shape check keep engine-controlled strings out of rendered `detail` text) and **by the committed-ADR redaction guard** (`claudexor-trace.test.ts`), which this ADR and its evidence file must also pass — with the caveat in "Not covered" below about what that guard does and does not catch. |
| Credential validity over time (expiry, revocation) | **not verified** — see "Not covered" |
| Cursor subscription profile | **not attempted** — out of this issue's stated scope |

**§10.4 claim, corrected.** An earlier draft of this ADR asserted that `IsolationViolationError` and
`SubscriptionRouteViolationError` are "the only two outcomes besides a clean subscription
attestation" — that sentence is false and has been removed. `classifyClaudeBillingRoute` and
`classifyCodexBillingRoute` are **total, non-throwing** functions: they always return an attestation
whose `route` is one of `subscription | api_key | third_party | none | indeterminate`, and `probe.ts`
never throws either (a spawn failure or unparseable output classifies `indeterminate`, it does not
raise). The two error types are real and do fail closed, but only at two specific points: building an
environment for a `carrierKind: "environment"` engine with no usable carrier
(`buildIsolatedEnvironment`), and asking `assertSubscriptionOnly` to vouch for an attestation that
is not an unambiguous, exclusively-subscription route. **What actually holds:** a caller that
composes `buildIsolatedEnvironment` → a probe → `assertSubscriptionOnly` gets a fail-closed run.
Composing those three calls is a **convention this issue establishes and tests**, not an invariant
the type system or a runtime enforces on every caller — nothing stops a caller from building an
attestation by hand, or from probing without ever calling `assertSubscriptionOnly` at all, and
getting a non-throwing `indeterminate`/`api_key`/`third_party` attestation back with no error raised.

## Stop-condition evaluation

Issue #5's autonomous-run instructions include stopping with a typed blocker if "a required
subscription route cannot be proven" — the same condition ADR 0002 evaluates for Claudexor's `/v2`
auth route (its O8). This issue hit an adversarial reading of exactly that condition mid-build, and
it is recorded here in full rather than quietly corrected away.

- **Condition considered:** a required subscription route cannot be proven.
- **The adversarial reading:** the initial implementation modelled Codex the same way as Claude — a
  named environment-variable carrier (`CODEX_CHATGPT_OAUTH_TOKEN`, itself an invented convention, not
  an observed upstream contract) plus a config-home variable (`CODEX_HOME`) this recipe overrides.
  Under that model, "prove the Codex subscription route" reduces to "prove the environment-variable
  carrier is what makes `heniek-codex login status` report the subscription" — and nothing in the
  grounded observations actually shows that; F1/F2 only show that Codex reports the subscription
  when *hostile* values are present alongside whatever the broker already provisions. Read this way,
  the Codex route looked unproven: the model asserted a mechanism (an environment-carried credential)
  that nothing had actually verified was load-bearing.
- **Settled by experiment, not by argument.** N1 and N2 (Observations, above) directly test the
  suspect mechanism: N1 runs `heniek-codex login status` under an environment containing ONLY `PATH`
  and `LANG` — no carrier variable, no config-home variable of any kind — and it reports the
  ChatGPT subscription. N2 repeats that with hostile `OPENAI_API_KEY`, `CODEX_API_KEY`,
  `OPENAI_BASE_URL`, `CODEX_HOME` and `HOME` all injected with poisoned values, and the outcome is
  unchanged. Together these show the Codex route **is** provable and reproducible — the defect was
  in the model (assuming Codex needed an environment-carried credential and a caller-supplied config
  home at all), not in the ability to prove the route. FIX-1 (this build) corrected the model:
  `VariablePolicy.carrierKind: "brokered"` for Codex, with `subscriptionCarriers: []` and
  `configHomeVariables: []`, and a fail-closed refusal if a caller supplies a `configHome` for it.
- **What remains genuinely unproven:** (1) credential **validity over time** — expiry and revocation
  cannot be shown without a metered provider round-trip, which this issue excludes by construction
  (O4 applies equally to Codex); this is unchanged by the model correction. (2) This issue proves the
  Codex route **through the broker** — `heniek-codex` is what owns and provisions the ChatGPT
  credential; N1/N2 attest that invoking the broker under a minimal, hostile-poisoned environment
  still reports the subscription, but this issue's code has no visibility into, and makes no claim
  about, how the broker itself stores or rotates that credential. This ADR attests the *route*, not
  the broker's own provisioning mechanism.
- **Re-verification step:** re-run N1 and N2 exactly as described (a minimal `PATH`+`LANG`
  environment, then the same environment plus the five hostile names above) against a currently
  pinned `codex-cli`/`heniek-codex` revision, and confirm `heniek-codex login status` still reports
  the ChatGPT subscription in both cases. If a future `heniek-codex` revision introduces an
  environment-variable-carried credential (making the original, corrected-away model
  retroactively partially correct for that revision), `VariablePolicy.codex.carrierKind` must be
  revisited alongside that pin bump, not silently left as `"brokered"`.
- **Why the build proceeds:** the condition that would require stopping — "cannot be proven" — was
  falsified by N1/N2 before this ADR was finalized. Proceeding records the corrected model rather than
  the disproven one.

**Product commitment note.** §10.4 requires the runtime to "verify the observed authentication route
when the backend exposes it". That commitment is satisfiable for both engines this issue covers:
Claude exposes `apiKeySource`/`authMethod`/`apiProvider` in a structured JSON diagnostic;
Codex exposes its route as a single English sentence (`"Logged in using ChatGPT"`) with two more
defensive, unverified phrasings for the other routes. The Codex exposure is recorded as a
**fragility** — a single unversioned string is a thinner contract than a JSON field — not as a
narrowing of §10.4's commitment: the commitment holds for both engines, one exposure surface is just
more brittle than the other.

## Live recipe run

Everything above this section is either a pure classifier covered by `pnpm check` or an observation
recorded before the code existed. This section is the one thing that closes the gap between them:
**the committed recipe itself, driving both live engines, from a deliberately hostile ambient
environment.** Without it, this ADR would attest classifiers over transcribed facts and would never
have shown that `buildIsolatedEnvironment`'s own output actually reaches a subscription route.

The driver constructs the hostile ambient environment from `VARIABLE_POLICY[engine].hostileCatalogue`
itself — every catalogued name is poisoned with a fabricated `SENTINEL-...-NOT-REAL` value, including
`PATH`, which is pointed at a nonexistent directory. It then calls `buildIsolatedEnvironment`,
`probeBillingRoute`, and `assertSubscriptionOnly` — the exact three-call composition the Consequences
section describes — and renders the result with this issue's own `renderEnvironmentDiff` and
`toMarkdownTable`. The full redacted output is in the evidence file's "Live recipe transcript".

| engine | carrierKind | hostile names injected | admitted into the child env | exit | attested route | `assertSubscriptionOnly` |
|---|---|---|---|---|---|---|
| claude | `environment` | 6 (incl. a poisoned `PATH`) | `PATH`, `LANG`, `HOME`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN` | 0 | `subscription` | passed |
| codex | `brokered` | 6 (incl. a poisoned `PATH`, `CODEX_HOME`, `HOME`) | `PATH`, `LANG` | 0 | `subscription` | passed |

Three properties are load-bearing and each is visible in that table rather than asserted:

1. **Zero hostile names were admitted.** `admittedHostileCount=0` for both engines, and the
   `hostileAmbient` canary reports `supported` for both — and it reports it having inspected the
   built `env` itself, not only the recipe's own decision list (FIX-4).
2. **The poisoned `PATH` never reached the child.** Both children ran with `PATH` set to the fixed
   `ISOLATED_PATH` constant. Had the ambient value been admitted, the Claude probe would have failed
   to spawn at all (it pointed at a nonexistent directory) — the failure would have been loud, which
   is the point: the ambient `PATH` is what decides which binary receives the carrier.
3. **Codex reached the subscription with an environment of exactly two variables**, neither of them a
   credential and neither a config home. That is the corrected `brokered` model (FIX-1) exercised end
   to end, and it is what the disproven `CODEX_CHATGPT_OAUTH_TOKEN` model could never have produced.

What this run does **not** establish is unchanged from the rest of this ADR: `validity` is
`presence_only` for both attestations, so this shows the route a credential is *presented* on, never
that the credential is still valid. See "Not covered".

## Not covered by this issue

- **Credential validity.** Expiry and revocation cannot be proven without a metered provider
  round-trip, which this issue excludes by construction. `AttestationValidity` is always
  `"presence_only"` here; nothing in this issue's code path can produce `"provider_verified"`. This
  is unchanged by the Codex carrier-model correction: N1/N2 attest presence and shape exactly as O4
  describes, never validity over time.
- **`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` are excluded by construction, not by observation.**
  No test in this issue can prove they were denied by *reading the diagnostic back*, because the
  diagnostic does not surface either variable's effect at all (O5). The only evidence available is
  that `buildIsolatedEnvironment` never admits an undeclared variable, checked directly against the
  decision list.
- **Cursor.** The issue's acceptance criteria name Claude and Codex only. `heniek-cursor` exists in
  this repository's tooling but is not exercised by this issue; this is recorded as scope, not as a
  gap.
- **The Codex `api_key` and not-logged-in text patterns are defensive and unverified.** Only the
  ChatGPT-subscription phrasing (`"Logged in using ChatGPT"`) was actually observed on the pinned
  host (design scenarios F1, F2, and N1/N2). The other two patterns in
  `packages/conformance/src/smoke/subscription/attestation.ts` are anticipated shapes, not confirmed
  ones, and are pinned by hermetic tests against fixture text rather than by a live CLI transcript.
  `classifyCodexBillingRoute` is ambiguity-safe (a text matching more than one pattern classifies
  `indeterminate`), but the assumption that the three patterns are disjoint in real output is itself
  unverified.
- **F3's `exec --with-api-key` refusal** (the broker CLI's own policy refusing that argument
  outright) is recorded as an existing safeguard in the grounded observations, but is not
  independently re-tested by this issue's classifiers: `classifyCodexBillingRoute` classifies login
  **status** text, not command-line argument policy, and re-implementing that refusal was out of
  this spike's scope.
- **How the `heniek-codex` broker itself provisions or stores the ChatGPT credential.** N1/N2 attest
  that the broker retains and reports the subscription under a minimal, hostile-poisoned invocation
  environment; they say nothing about the broker's internal storage, rotation, or failure modes.
  This issue's code has no visibility into that mechanism and makes no claim about it — see
  "Stop-condition evaluation" above.
- **The committed-ADR redaction guard's coverage is narrower than "no credential can leak here".**
  `claudexor-trace.test.ts`'s guard is an 11-clause denylist (path prefixes, the `Bearer`
  authorization-header prefix, and five credential-prefix patterns). It does not, and structurally cannot, catch a bare-hex token, a JWT,
  or an arbitrary session artifact that does not match one of those eleven clauses. The stronger
  property this ADR and its evidence file actually rely on — that no credential VALUE of any shape
  appears — follows from the renderers' construction (`VariableDecision` and
  `BillingRouteAttestation` only ever carry names, presence booleans, decisions, and a small
  enumerated vocabulary; `bounded()` and the `apiKeySource` shape check keep any other engine-reported
  string out of rendered text entirely), exactly as ADR 0002 states for its own event trace. The scan
  is a floor, not the source of the guarantee.
- No production adapter, daemon, or engine-management CLI. No change to `smoke/claudexor/**`,
  `packages/contracts/**`, GitHub Actions, or branch rules.

## Consequences

- A caller that wants a subscription-only run composes exactly three calls: `buildIsolatedEnvironment`
  (fails closed for a `carrierKind: "environment"` engine if the carrier is missing, or for a
  `carrierKind: "brokered"` engine if a `configHome` is supplied), a probe (`probeClaudeBillingRoute` /
  `probeCodexBillingRoute`, the only impure module, with an injectable runner for hermetic testing),
  and `assertSubscriptionOnly` on the result. As the corrected §10.4 coverage note above states, this
  is a **convention**, not a type-level or runtime-level enforced invariant — a caller can still
  build an attestation by hand or skip `assertSubscriptionOnly`.
- The billing-route vocabulary (`BillingRoute`, `AttestationValidity`) lives in
  `packages/conformance`, not `packages/contracts` — it is this issue's spike vocabulary, not yet a
  product contract. Promoting it is a later issue's decision.
- The canaries are opt-in and never run in CI; `pnpm check` stays hermetic and offline. The
  classifiers and the recipe they depend on are pure and are covered exhaustively by `pnpm check`,
  including the previously-untested `probe.ts` failure classification and `environment-diff.ts`
  rendering (both now hermetically tested via an injectable runner and direct renderer tests,
  respectively).
- These are this recipe's own **declared** carrier and config-home variable names, not a claim about
  documentation any upstream project publishes. The N1/N2/N3 observations record what environments
  built from these declared names actually produced against the pinned CLIs on the observing host —
  that is the only claim this ADR makes about them.
- A committed, redacted environment diff and canary table exist as evidence, plus a drift guard
  (`subscription-evidence-drift.test.ts`) that regenerates the evidence file's rendered tables from
  their documented fixtures and asserts the committed file still matches verbatim. The same
  committed-ADR redaction guard that covers ADR 0002 (`claudexor-trace.test.ts`) scans this document
  and its evidence file for credential- and path-shaped substrings, with the coverage caveat recorded
  in "Not covered" above.

## Findings carried in from the grounded observations (design-time)

These were already known from the design artifact's grounded observation table (§2, findings F-1
through F-5) before implementation began; they shaped the design rather than being discovered by it.

| Finding | Design-time source | Pinned by |
|---|---|---|
| Attesting on `authMethod === "oauth_token"` alone would pass a run with a visible ambient API key (D/E5) | F-1 | `subscription-attestation.test.ts` |
| Attesting on `loggedIn === true` alone would pass a silently re-routed third-party billing mode (E3/E4) | F-2 | `subscription-attestation.test.ts` |
| A "copy ambient, then delete known-bad names" build can only ever exclude names someone thought to enumerate, and cannot exclude an effect the one allowed diagnostic never surfaces (`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`) | F-5 | `subscription-variables.test.ts` |
| Treating the local diagnostic as validity would let a fabricated carrier attest as a live subscription (G1) | F-4 | `subscription-attestation.test.ts` |
| Returning "logged out" instead of failing when the carrier is absent would re-open the silent-fallback path (G3) | F-3 | `subscription-variables.test.ts` |
| A loose "Logged in" substring match on Codex status text would classify an API-key login as a subscription | design §3.1's explicit classification-order requirement | `subscription-attestation.test.ts` |

## Defects discovered while implementing

These were found only while writing and testing the code — none were anticipated by the design
artifact's grounded observations.

| Defect | Pinned by |
|---|---|
| The original Codex `VariablePolicy` modelled the subscription carrier as a named environment variable (`CODEX_CHATGPT_OAUTH_TOKEN`, an invented convention) with a config-home override, when N1/N2 show Codex needs neither — a config home supplied to a brokered engine actively misrepresents where the credential lives (FIX-1) | `subscription-variables.test.ts` ("Codex, brokered carrier model" describe block) |
| The Claude `configHomeVariables` list was missing `HOME`; N3 shows the diagnostic fails hard (exit 1, empty stdout, an internal stack trace on stderr) without it, even with `CLAUDE_CONFIG_DIR` set | `subscription-variables.test.ts` (`[regression] always includes HOME`) |
| Fabricating a placeholder diagnostic on unparseable `claude auth status --json` output (e.g. defaulting `loggedIn` to `false`) would misclassify a parse failure as the same route as an honest logged-out session; the same risk applied, previously untested, to a spawn-level failure being folded into the same route as "not logged in" | `subscription-attestation.test.ts` (parse-failure throw); `subscription-probe.test.ts` (spawn failure and parse failure both classify `indeterminate`, never `none`) |
| Classifying every carrier-present, presence-only attestation as `degraded` (rather than gating on an expiry/revocation scenario specifically) would make an ordinary successful subscription attestation unable to ever report `supported` | `subscription-canaries.test.ts` |
| `bounded()`'s original character-deletion approach (a keep-list of word characters, dot, colon and hyphen) removed exactly the `/` and space characters the committed-ADR redaction guard keys on, while leaving every credential-prefix substring the guard's own patterns match (an API-token-style prefix, a GitHub-token-style prefix, the `Bearer` authorization-header prefix minus its trailing space, an absolute path minus its slashes) intact — laundering rather than redacting | `subscription-attestation.test.ts` ("bounded() redaction" describe block) |
| `apiKeySource` was accepted as any non-empty string, so a credential-shaped diagnostic value could reach `exposedKeySources`, a `detail` string, and a thrown `SubscriptionRouteViolationError`'s message unredacted | `subscription-attestation.test.ts` (`parseClaudeAuthDiagnostic` apiKeySource-shape tests) |
| `probeClaudeBillingRoute`/`probeCodexBillingRoute` typed a spawn-level `execFile` failure's `error.code` (a STRING, e.g. `"ENOENT"`, on a spawn failure) into a field declared `number`, silently coercing "the command is not on PATH" into what looked like an ordinary numeric exit code | `subscription-probe.test.ts` |
| `classifyHostileAmbient` trusted `decisions` alone; a decision list that (by a bug elsewhere) claimed `denied-hostile` for a name that nonetheless reached the built `env` would still report `supported`; separately, an injected hostile name entirely absent from `decisions` (never evaluated) defaulted to the same lenient `supported` outcome as a name correctly evaluated and excluded | `subscription-canaries.test.ts` (both regression cases in the `classifyHostileAmbient` describe block) |
| `toMarkdownTable` (canaries) performed no cell escaping while `renderEnvironmentDiff` (environment diff) escaped `|` and newlines, an inconsistency that would let a canary name or evidence value corrupt the rendered table's column structure | `subscription-canaries.test.ts` (escaping test) |
| `classifyCodexBillingRoute` took the first matching pattern in a fixed order, which is only correct if the three patterns are disjoint — an assumption never verified, since only the subscription phrasing was ever actually observed | `subscription-attestation.test.ts` (ambiguous-match regression test) |
| `probe.ts` and `environment-diff.ts` had zero committed test coverage; both are pure or near-pure (probe's impurity is confined to one injectable seam) and were exercisable only through the opt-in, never-run-in-CI smoke test | `subscription-probe.test.ts`, `subscription-environment-diff.test.ts` |
| `subscription-variables.test.ts`'s `it.each` cases were derived directly from `VARIABLE_POLICY`'s own catalogues, so deleting a catalogue entry would silently remove a test case rather than fail one | `subscription-variables.test.ts` ("VARIABLE_POLICY — explicit pins" describe block) |
| The evidence file's rendered tables were hand-authored to look like renderer output, with nothing to stop them drifting from what the renderers actually produce | `subscription-evidence-drift.test.ts` |
| The Codex probe (`classifyRawDiagnostic` in `probe.ts`) classified from stdout only, so the brokered diagnostic's stderr-borne status line (N4a) was invisible and the opt-in canary attested `indeterminate` for a live, logged-in ChatGPT subscription | `subscription-probe.test.ts` (the N4a stderr-only regression case, plus the crash-style-stderr and cross-stream-ambiguity cases) |

## Additional hardening applied during this build (beyond FIX-1…FIX-18)

The code carries its own "review finding N" labels (distinct numbering from FIX-1…FIX-18 above) for
a further round of hardening applied during the same implementation pass, before this ADR was
finalized. Recorded here for the same reason every other defect in this document is recorded — so
none of it is silently unaccountable:

- **Review finding 2 — `PATH` pinning.** See Decision point 11 above: `PATH` moved from `neutral`
  (admitted through unchanged) to a dedicated, always-fixed `ISOLATED_PATH` constant for both
  engines, closing a bare-name `execFile` resolution risk.
- **Review finding 3 — the `logged_out` inversion in `classifyCredentialLifecycle`.** The original
  fourth branch ("a carrier is present and the attestation is `subscription` outside an
  expiry/revocation probe → `supported`") silently covered `logged_out` too, so a logout that did
  NOT take effect (`{scenario: "logged_out", carrierPresent: true, route: "subscription"}`) was
  reported as a pass. `classifyCredentialLifecycle` now branches on `scenario` explicitly (adding a
  `"baseline"` scenario alongside the existing four), and `logged_out` + `subscription` is
  `unsupported`. Every `supported` verdict additionally requires no exposed key source.
- **Review finding 6 — `apiKeySource` sanitize-not-throw.** See Decision point 9's revision above:
  `parseClaudeAuthDiagnostic` now sanitises a non-env-var-name-shaped `apiKeySource` to
  `<unexpected-value>` instead of throwing, so classification and the fail-closed
  `assertSubscriptionOnly` gate can still run rather than the caller losing the whole attestation to
  an aborted parse. A structurally-wrong type (not a string at all) still throws.
- **Review finding 7 — cell-escaping completeness and a length bound.** `escapeMarkdownTableCell`
  (in `environment-diff.ts`, imported by `canaries.ts`) now also collapses a lone `\r` (not just
  `\r\n`/`\n`) and bounds any cell to a fixed maximum length with a truncation marker.
- **Review finding 11 — a single shared escaping function.** `toMarkdownTable` now imports
  `escapeMarkdownTableCell` from `environment-diff.ts` rather than maintaining an independent copy,
  closing the drift risk of two escaping implementations disagreeing (this also folds in review
  finding 7's fixes for both renderers at once), and adds a not-logged-in phrasing that mentions
  "ChatGPT" to `classifyCodexBillingRoute`'s test coverage to confirm the ambiguity check does not
  over-fire on a plausible near-miss.

None of this hardening narrows, contradicts, or reopens any FIX-1…FIX-18 item above; it was applied
in the same build, verified by `pnpm check`, and is reflected in the current source, the evidence
file, and the test files this ADR's tables cite.
