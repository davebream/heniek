# 3. Subscription-only Claude Code and Codex engine profiles under a hostile ambient environment

- Status: accepted
- Date: 2026-08-01
- Issue: davebream/heniek#5 (Q004, `T0-evidence`, milestone M0)
- Spec anchors: §9.1 Accounts, §10.4 Billing guard, §27.4 Secrets and logs
- Evidence: [`evidence/0003-subscription-isolation-matrix.md`](evidence/0003-subscription-isolation-matrix.md)

## Context

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

## The pins under test

`claude` 2.1.220, `codex-cli` 0.146.0 (surfaced through this project's `heniek-codex` broker CLI).
Neither diagnostic issues a model request. The credential/environment observations below were
collected against these pins before this build began and are recorded here as already-obtained
facts, exactly as this issue's planning artifact transcribed them — they are not themselves
reproducible from a fresh clone, because reproducing them needs an installed, pinned CLI and an
authenticated subscription session on the observing host. What **is** reproducible from this
repository alone, by `pnpm check`, is everything built on top of those facts: the isolation recipe,
the classifiers, the redacted diff renderer, and every regression test below.

## Commands

```
HENIEK_CONFORMANCE_SMOKE=1 \
HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE=none \
HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION=1 \
pnpm vitest run packages/conformance/test/subscription.smoke.test.ts
```

`AUTH_ROUTE=none` is the same declaration ADR 0002 makes for the Claudexor gate: it says this gate
provisions no auth route of its own. It is not evidence about the effective route — that is what
`classifyClaudeBillingRoute` / `classifyCodexBillingRoute` exist to attest, from the diagnostic, not
from an opt-in flag. `HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT` may additionally name a
scratch directory **outside this repository** for transient engine config homes; nothing from it
enters this repository, for the same reason nothing from `..._CLAUDEXOR_ROOT` does.

Everything except the opt-in smoke file runs unconditionally in `pnpm check`:

```
pnpm vitest run packages/conformance/test/subscription-variables.test.ts \
  packages/conformance/test/subscription-attestation.test.ts \
  packages/conformance/test/subscription-canaries.test.ts \
  packages/conformance/test/subscription-gate.test.ts
```

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
off at the source: it refuses to build any environment at all when the declared carrier is absent
or empty (`IsolationViolationError`), so this scenario can only be reached by a caller that bypasses
the recipe, and `classifyCredentialLifecycle` separately reports `carrierPresent: false` combined
with `route: "api_key"` as `unsupported` if it is ever observed downstream anyway.

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

## Decision

The recipe in `packages/conformance/src/smoke/subscription/variables.ts` is accepted as the v1
mechanism for constructing a subscription-only child-process environment, subject to the "Not
covered" section below. The mechanism must:

1. **Build the child environment from `{}` by explicit allowlist decision, never from a copy of
   `ambient`.** This is the only construction that can exclude O5's invisible variables at all, and
   it is what makes an unenumerated future hostile variable fail closed by default rather than by
   having been anticipated.
2. **Fail closed (`IsolationViolationError`) when the declared subscription carrier is absent or
   empty**, rather than returning a "logged out" style environment a caller could still run. §10.4
   requires failing, not silently changing billing mode, and a returned-but-empty environment is
   exactly the silent path O3 demonstrates.
3. **Require `apiKeySource`'s absence, not `authMethod` alone, to attest `subscription`** (O1), and
   **check `apiProvider` before `loggedIn`** (O2), in that order — both pinned by classification-order
   regression tests.
4. **Never emit `validity: "provider_verified"`** from any diagnostic this issue can observe (O4).
5. **Exclude `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` by construction** rather than relying on
   detecting their effect (O5).
6. **Classify Codex login-status text by stable, disjoint substrings, never a loose "logged in"
   match** — an API-key-shaped login line also contains the word sequence a looser match would key
   on.

`assertSubscriptionOnly` is the fail-closed gate a caller must run before treating any attestation as
authorization to proceed: it throws unless the route is unambiguously `subscription` **and** no key
source is reported as visible.

## §9.1 / §10.4 / §27.4 coverage from this issue

| Spec item | Status |
|---|---|
| §9.1 — a `subscription_only` run may never silently fall back to an API key | **verified** by construction (fail-closed carrier check) and by regression test (O3 / G3) |
| §10.4 — the runtime must fail rather than silently change billing mode | **verified** — `IsolationViolationError` / `SubscriptionRouteViolationError` are the only two outcomes besides a clean `subscription` attestation |
| §27.4 — no credential value in logs or committed artifacts | **verified** by construction (`VariableDecision` and `BillingRouteAttestation` never carry a value) and by the committed-ADR redaction guard (`claudexor-trace.test.ts`), which this ADR and its evidence file must also pass |
| Credential validity over time (expiry, revocation) | **not verified** — see "Not covered" |
| Cursor subscription profile | **not attempted** — out of this issue's stated scope |

## Not covered by this issue

- **Credential validity.** Expiry and revocation cannot be proven without a metered provider
  round-trip, which this issue excludes by construction. `AttestationValidity` is always
  `"presence_only"` here; nothing in this issue's code path can produce `"provider_verified"`.
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
  host (design scenarios F1, F2). The other two patterns in
  `packages/conformance/src/smoke/subscription/attestation.ts` are anticipated shapes, not confirmed
  ones, and are pinned by hermetic tests against fixture text rather than by a live CLI transcript.
- **F3's `exec --with-api-key` refusal** (the broker CLI's own policy refusing that argument
  outright) is recorded as an existing safeguard in the grounded observations, but is not
  independently re-tested by this issue's classifiers: `classifyCodexBillingRoute` classifies login
  **status** text, not command-line argument policy, and re-implementing that refusal was out of
  this spike's scope.
- **The Codex subscription-carrier variable name (`CODEX_CHATGPT_OAUTH_TOKEN`) is this issue's own
  broker convention**, not an observed upstream Codex CLI environment variable. Unlike
  `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, which are documented upstream
  variables, this name is invented for the "brokered Codex" shape the design artifact describes and
  is recorded here explicitly so it is never mistaken for an observed contract.
- No production adapter, daemon, or engine-management CLI. No change to `smoke/claudexor/**`,
  `packages/contracts/**`, GitHub Actions, or branch rules.

## Consequences

- A caller that wants a subscription-only run composes exactly three calls: `buildIsolatedEnvironment`
  (fails closed if the carrier is missing), a probe (`probeClaudeBillingRoute` /
  `probeCodexBillingRoute`, the only impure module), and `assertSubscriptionOnly` on the result. None
  of the three can be skipped without an explicit code change, and none of them can pass on a
  fabricated or ambiguous route.
- The billing-route vocabulary (`BillingRoute`, `AttestationValidity`) lives in
  `packages/conformance`, not `packages/contracts` — it is this issue's spike vocabulary, not yet a
  product contract. Promoting it is a later issue's decision.
- The canaries are opt-in and never run in CI; `pnpm check` stays hermetic and offline. The
  classifiers and the recipe they depend on are pure and are covered exhaustively by `pnpm check`.
- A committed, redacted environment diff and canary table exist as evidence. The same
  committed-ADR redaction guard that covers ADR 0002 (`claudexor-trace.test.ts`) scans this document
  and its evidence file for credential- and path-shaped substrings.

## Defects found while implementing, and the tests that pin them

| Defect | Pinned by |
|---|---|
| Attesting on `authMethod === "oauth_token"` alone passes a run with a visible ambient API key (D/E5) | `subscription-attestation.test.ts` |
| Attesting on `loggedIn === true` alone passes a silently re-routed third-party billing mode (E3/E4) | `subscription-attestation.test.ts` |
| Scrubbing known-bad names out of a copied ambient env leaves unknown credential-shaped names in place | `subscription-variables.test.ts` |
| Treating the local diagnostic as validity lets a fabricated carrier attest as a live subscription (G1) | `subscription-attestation.test.ts` |
| Matching Codex status by a loose "Logged in" substring would classify an API-key login as a subscription | `subscription-attestation.test.ts` |
| Returning "logged out" instead of failing when the carrier is absent re-opens the silent-fallback path (G3) | `subscription-variables.test.ts` |
| Fabricating a placeholder diagnostic on unparseable `claude auth status --json` output (e.g. defaulting `loggedIn` to `false`) would misclassify a parse failure as the same route as an honest logged-out session | `subscription-attestation.test.ts` |
| Classifying every carrier-present, presence-only attestation as `degraded` (rather than gating on an expiry/revocation scenario specifically) would make an ordinary successful subscription attestation unable to ever report `supported` | `subscription-canaries.test.ts` |
| Listing `CODEX_HOME` in the hostile catalogue — which the grounded observation table's wording for scenario F2 could suggest — instead of relying solely on the config-home override risks the ambient (poisoned) value winning depending on processing order | `subscription-variables.test.ts` |
