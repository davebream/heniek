# Evidence — subscription-only Claude Code and Codex engine profiles (ADR 0003)

Every table below is either rendered directly by this issue's own code
(`renderEnvironmentDiff`, `toMarkdownTable`) or is a redacted transcript of the
diagnostic shapes recorded in this issue's grounded observation table. No
credential value, no filesystem path from any host, and no prompt or model
output appears anywhere in this file — only variable **names**, presence
booleans, decisions, and small enumerated fields (`authMethod`, `apiProvider`,
route names) that this issue's diagnostics report directly.

`test/subscription-evidence-drift.test.ts` regenerates every rendered table
below from the exact fixtures documented alongside each one and asserts the
regenerated text matches this file verbatim, so this file's claim that its
tables are machine-rendered cannot silently drift out of sync with the code
that renders them.

Two fabricated sentinel values are used throughout, purely to exercise the
renderers below; both are `SENTINEL-...-NOT-REAL` strings and are never
credential-shaped:

- `SENTINEL-CLAUDE-CARRIER-NOT-REAL` — stands in for a Claude subscription
  carrier value.
- `SENTINEL-HOSTILE-VALUE-NOT-REAL` — stands in for a hostile-catalogue
  variable's value.

Neither sentinel ever appears in the tables below: `renderEnvironmentDiff`
only ever emits a variable's **name**, whether it was **present**, and the
**decision** made about it — never a value. That is a property of the
renderer, not an accident of these particular fixtures.

## Redacted environment diff — Claude, scenario D (isolated + carrier, plus a leaked key)

Built by `buildIsolatedEnvironment` from an ambient environment carrying the
Claude subscription carrier, every hostile-catalogue name from
`VARIABLE_POLICY.claude`, one unrecognised credential-shaped name, and two
ordinary neutral variables — then rendered by `renderEnvironmentDiff`.
`PATH` is always the fixed, recipe-owned constant (`admitted-fixed`), never
the ambient value, for every engine — see ADR 0003's Decision section.

| variable | in ambient | decision |
| --- | --- | --- |
| PATH | true | admitted-fixed |
| CLAUDE_CODE_OAUTH_TOKEN | true | admitted-carrier |
| HOME | false | admitted-config-home |
| CLAUDE_CONFIG_DIR | false | admitted-config-home |
| ANTHROPIC_API_KEY | true | denied-hostile |
| ANTHROPIC_AUTH_TOKEN | true | denied-hostile |
| ANTHROPIC_BASE_URL | true | denied-hostile |
| CLAUDE_CODE_USE_BEDROCK | true | denied-hostile |
| CLAUDE_CODE_USE_VERTEX | true | denied-hostile |
| LANG | true | admitted-neutral |
| SOME_OTHER_SERVICE_API_KEY | true | denied-unlisted |

`HOME` and `CLAUDE_CONFIG_DIR` both show `in ambient: false` — the ambient
environment never set either at all — and both are still admitted, with the
recipe's own dedicated config-home value, never an ambient one (N3: Claude's
diagnostic fails hard without `HOME`, so both variables are always derived
from `configHome`, never merely one of them). An unrelated ambient variable
this fixture also carried (`SHLVL`) is absent from the table entirely: it is
neither a declared name nor credential-shaped, so it is excluded from the
built environment but not reported, exactly as `variables.ts` documents.

## Redacted environment diff — Codex, brokered carrier model (corrected; supersedes the original scenario-F2 table)

**This table replaces an earlier version of this file**, which rendered a
Codex environment diff under the ADR's original — and incorrect —
`carrierKind: "environment"` model for Codex (a named carrier variable plus a
`CODEX_HOME` override). N1/N2 (ADR 0003, design doc §2) showed that model was
wrong: Codex needs no environment-carried credential and no caller-supplied
config home at all. This table is built by `buildIsolatedEnvironment` under
the corrected `carrierKind: "brokered"` model, from an ambient environment
carrying every ordinary hostile-catalogue name from `VARIABLE_POLICY.codex`
plus a **poisoned** `CODEX_HOME` and `HOME` — the same adversarial shape N2
tested against the real `heniek-codex` broker:

| variable | in ambient | decision |
| --- | --- | --- |
| PATH | true | admitted-fixed |
| OPENAI_API_KEY | true | denied-hostile |
| CODEX_API_KEY | true | denied-hostile |
| OPENAI_BASE_URL | true | denied-hostile |
| CODEX_HOME | true | denied-broker-owned |
| HOME | true | denied-broker-owned |

No `admitted-carrier` row and no `admitted-config-home` row appear at all —
unlike Claude, the brokered Codex model never admits a carrier variable or a
caller-supplied config home; `CODEX_HOME` and `HOME` get the dedicated
`denied-broker-owned` outcome (not the generic `denied-hostile`) because the
`heniek-codex` broker owns them entirely, per N2 — the poisoned ambient values
shown here are excluded, and the broker's own config home (invisible to this
recipe) is what N1/N2 show actually wins.

## Canary table

Rendered by `toMarkdownTable` from six representative
`classifyHostileAmbient` / `classifyCredentialLifecycle` **calls over
declared fixtures** — **not from a live canary run**. Every row is a
classifier's output over a caller-supplied scenario label and attestation,
never an observation of a real engine invocation; see the labelling note
below the table.

| canary | outcome | evidence |
| --- | --- | --- |
| hostileAmbient | degraded | injectedHostileCount=5; admittedHostileCount=0; route=indeterminate |
| credentialLifecycle | unsupported | scenario=carrier_absent; carrierPresent=false; route=api_key; validity=presence_only |
| credentialLifecycle | supported | scenario=carrier_absent; carrierPresent=false; route=none; validity=presence_only |
| credentialLifecycle | degraded | scenario=expiry; carrierPresent=true; route=subscription; validity=presence_only |
| credentialLifecycle | supported | scenario=baseline; carrierPresent=true; route=subscription; validity=presence_only |
| credentialLifecycle | unsupported | scenario=logged_out; carrierPresent=true; route=subscription; validity=presence_only |

**Labelling note (`credentialLifecycle` rows are classifier outputs, not
canary runs).** Every `credentialLifecycle` row is
`classifyCredentialLifecycle`'s output over a **caller-declared scenario
label** (`baseline` / `expiry` / `revocation` / `carrier_absent` /
`logged_out`) plus a fixture attestation. No committed code observes expiry,
revocation, or an actual logout taking effect (F-4) — `scenario` is a label
a caller supplies, and the classifier reasons about that label plus the
attestation, nothing more.

Row 1 (`hostileAmbient`) is `degraded`, not `supported`: every
hostile-catalogue variable was correctly excluded (`admittedHostileCount=0`),
but scenario D's diagnostic also carries a visible `apiKeySource`, so
`classifyClaudeBillingRoute` correctly attests `indeterminate` rather than
`subscription` — the isolation held, the credential shape did not. This is
the intended, honest outcome for that specific input, not a failure of the
recipe.

Row 4 (`scenario=expiry`) is `degraded`: F-4's limit means the diagnostic
proves presence and shape, never validity, so an `expiry`-labelled scenario
can never report `supported` even from an attestation that otherwise looks
like an ordinary successful subscription.

**Rows 5–6 document the logout-inversion fix.** `scenario=baseline` with
`route=subscription` is the genuine ordinary pass (`supported`).
`scenario=logged_out` with `route=subscription` is **not** a pass: it means
a logout was declared but the diagnostic still shows a live subscription
route, i.e. the logout did not take effect and the session survived it.
Before this fix, `classifyCredentialLifecycle` incorrectly reported this
exact combination as `supported`; it now correctly reports `unsupported`.

## Redacted diagnostic transcripts — scenarios A–G

Each row is the diagnostic shape this issue's grounded observation table
records, redacted to the fields `classifyClaudeBillingRoute` /
`classifyCodexBillingRoute` actually read. `apiKeySource`, where present, is
always a variable **name** the CLI reports as visible, never a value.

**Labelling note (attested-route provenance).** The "attested route" column
is **computed post-hoc**, by this issue's own classifiers, from the
diagnostic shape recorded in the design artifact's grounded observation
table — it was not itself observed at collection time. The collection-time
observation was the raw diagnostic (or Codex stdout line) only; the route is
this repository's classification of that shape, run today against the
pinned classifier code, not a value that was ever printed by the CLI itself.

| scenario | diagnostic (redacted) | attested route (computed post-hoc by the classifier) |
| --- | --- | --- |
| A — ambient hostile key, no isolation | `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}` | indeterminate |
| B — scrubbed env + fresh config home, no carrier | `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}` | none |
| C — dedicated home + allowlisted carrier, hostile names denied | `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}` | subscription |
| D — C plus a leaked ANTHROPIC_API_KEY | `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}` | indeterminate |
| E1 — C plus ANTHROPIC_AUTH_TOKEN (no observable diagnostic change) | `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}` | subscription |
| E2 — C plus ANTHROPIC_BASE_URL (no observable diagnostic change) | `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}` | subscription |
| E3 — C plus CLAUDE_CODE_USE_BEDROCK=1 | `{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}` | third_party |
| E4 — C plus CLAUDE_CODE_USE_VERTEX=1 | `{"loggedIn":true,"authMethod":"third_party","apiProvider":"vertex"}` | third_party |
| E5 — C plus API key and auth token together | `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}` | indeterminate |
| F1 — brokered Codex + hostile OPENAI_API_KEY / CODEX_API_KEY | `Logged in using ChatGPT` | subscription |
| F2 — brokered Codex + hostile CODEX_HOME / OPENAI_BASE_URL | `Logged in using ChatGPT` | subscription |
| F3 — brokered Codex, `exec --with-api-key` | refused by the broker's own policy before any diagnostic runs | n/a — see ADR "Not covered" |
| G1 — isolated home + fabricated carrier | `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}` | subscription (validity: presence_only — see ADR O4) |
| G2 — isolated home + empty carrier | `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}` | none |
| G3 — isolated home, no carrier, hostile key present | `{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}` | api_key |

### N-series — newly recorded observations (distinct from A–G, collected during this build)

Unlike A–G, these were not part of the original grounded observation table —
they were collected mid-build, after the initial Codex model raised the
adversarial stop-condition question ADR 0003's "Stop-condition evaluation"
section records. They are the empirical basis for the `carrierKind:
"brokered"` correction (FIX-1).

| scenario | environment | diagnostic (redacted) | note |
| --- | --- | --- | --- |
| N1 — Codex, minimal environment | ONLY `PATH`, `LANG` — no carrier, no config-home variable of any kind | `Logged in using ChatGPT`, exit 0 | Codex needs no environment-carried credential and no caller-supplied config home at all. |
| N2 — Codex, minimal environment + poisoned hostile values | N1's environment plus hostile `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`, `CODEX_HOME`, `HOME` | `Logged in using ChatGPT`, exit 0 — unchanged from N1 | The broker retains and reports the subscription regardless of a poisoned ambient config home; the broker's own home wins, not the ambient one. |
| N3 — Claude, `HOME` present vs. absent | `PATH`, `LANG`, `HOME=<configHome>`, `CLAUDE_CONFIG_DIR=<configHome>/.claude`, `CLAUDE_CODE_OAUTH_TOKEN` — vs. the same minus `HOME` | With `HOME`: `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}`, exit 0. Without `HOME`: exit 1, empty stdout, an internal stack trace on stderr (redacted here; never committed verbatim). | `CLAUDE_CONFIG_DIR` alone is not sufficient; `HOME` alone is. Drove the `configHomeVariables` fix for Claude. |
| N4a — Codex, recipe environment (newly recorded) | `PATH` = the fixed `ISOLATED_PATH`, `LANG` | exit 0; stdout 0 bytes (empty); stderr carries the status line `Logged in using ChatGPT\n` | The brokered diagnostic's status line arrives on stderr, not stdout — the broker relays the underlying engine's output back over its own socket bridge. Drove the combined-stream read fix for `probeCodexBillingRoute`. |
| N4b — Claude, recipe environment (newly recorded) | same recipe environment as N3's `HOME`-present case | exit 0; stdout 85 bytes (a JSON document); stderr 0 bytes (empty) | Claude's diagnostic stays stdout-only and JSON-shaped; unchanged by the Codex fix. |

`classifyCodexBillingRoute("Logged in using ChatGPT")` (the shape N1/N2 both
observed) attests exactly as F1/F2 do:

```json
{"engine":"codex","route":"subscription","validity":"presence_only","exposedKeySources":[],"detail":"login status reports a ChatGPT subscription login."}
```

### Codex classification, defensive patterns

Only the F1/F2/N1/N2 line was observed on the pinned host. The other two rows
below exercise `classifyCodexBillingRoute`'s defensive patterns against
fixture text; they are not confirmed against a real CLI transcript (see the
ADR's "Not covered" section):

| input text (fixture) | attested route (computed post-hoc by the classifier) |
| --- | --- |
| `Logged in using ChatGPT` (observed, F1/F2, N1/N2) | subscription |
| `Logged in using an API key` (defensive, not observed) | api_key |
| `Not logged in.` (defensive, not observed) | none |
| `Not logged in with ChatGPT` (defensive, not observed — realistic near-miss, not ambiguous) | none |

## Live recipe transcript

Unlike every table above — which is either a classifier output over fixtures or
a redacted transcript of a previously-recorded diagnostic — this section
records an **actual execution of the opt-in canary suite** against the
locally-installed `claude` 2.1.220 and `heniek-codex` (`codex-cli` 0.146.0), on
Node.js 24.18.1 / pnpm 11.13.0. Both arms build their environment with
`buildIsolatedEnvironment`, probe the real diagnostic, and pass the result
through `assertSubscriptionOnly`, which throws unless the route is
unambiguously `subscription` with no exposed key source.

Command:

```
HENIEK_CONFORMANCE_SMOKE=1 \
HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE=subscription \
HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION=1 \
pnpm vitest run packages/conformance/test/subscription.smoke.test.ts
```

Result, exit code 0:

```
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

The two passing tests are:

| arm | carrier model | config home | assertion |
| --- | --- | --- | --- |
| Claude | `carrierKind: "environment"` — `CLAUDE_CODE_OAUTH_TOKEN` admitted from ambient | dedicated, created per run, removed afterwards | `assertSubscriptionOnly` did not throw |
| Codex | `carrierKind: "brokered"` — no carrier variable admitted | none supplied; the `heniek-codex` broker owns its own | `assertSubscriptionOnly` did not throw |

This is the run that produced N4a and N4b. On its first execution the Codex arm
**failed**, with
`SubscriptionRouteViolationError: codex billing route is not subscription-only
(route="indeterminate")` — the defect N4a records, where the brokered status
line arrives on stderr while the probe read stdout only. Both the failure and
the pass are reported here rather than only the favourable one, because the
failure is the evidence that this suite can actually go red against a live
engine: a canary that has never failed is a canary of unknown strength.

What this transcript does **and does not** establish: it establishes that the
recipe composes end-to-end against both real CLIs and that each reports its
named subscription route under an environment built from empty by allowlist. It
does **not** establish credential validity over time — both diagnostics are
local and offline (`validity: "presence_only"`; ADR 0003, O4), so no row above
survives an expiry or revocation that has not yet been reflected locally.

### The same recipe under a fully poisoned ambient environment

The suite run above builds from the process's own ambient environment, which on
the observing host happened to be clean of every hostile name. That leaves the
central claim of this issue — isolation under a *hostile* parent environment —
demonstrated only by hermetic tests. This second run closes that gap.

A driver (not committed; it lives outside the tracked tree) imports only this
issue's public surface and constructs the hostile ambient environment from
`VARIABLE_POLICY[engine].hostileCatalogue` itself: **every catalogued name set
to a fabricated `SENTINEL-HOSTILE-VALUE-NOT-REAL` value, including `PATH`,
pointed at a directory that does not exist.** Only the real Claude subscription
carrier is passed through, by name, never read or printed. The driver then calls
`buildIsolatedEnvironment` → `probeBillingRoute` → `assertSubscriptionOnly` — the
exact three-call composition the ADR's Consequences section describes — and
renders with this issue's own `renderEnvironmentDiff` and `toMarkdownTable`.

#### Claude arm — built environment

| variable | in ambient | decision |
| --- | --- | --- |
| PATH | true | admitted-fixed |
| CLAUDE_CODE_OAUTH_TOKEN | true | admitted-carrier |
| HOME | false | admitted-config-home |
| CLAUDE_CONFIG_DIR | false | admitted-config-home |
| ANTHROPIC_API_KEY | true | denied-hostile |
| ANTHROPIC_AUTH_TOKEN | true | denied-hostile |
| ANTHROPIC_BASE_URL | true | denied-hostile |
| CLAUDE_CODE_USE_BEDROCK | true | denied-hostile |
| CLAUDE_CODE_USE_VERTEX | true | denied-hostile |
| LANG | true | admitted-neutral |

```
Admitted variable names: CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR, HOME, LANG, PATH
exitCode=0 spawnFailure=false
attestation.route=subscription  attestation.validity=presence_only  attestation.exposedKeySources=[]
assertSubscriptionOnly: PASSED (no throw)
```

`PATH` reads `in ambient: true` / `admitted-fixed`: the ambient value **was**
present and poisoned, and the recipe substituted the fixed `ISOLATED_PATH`
constant for it. Had the ambient value been admitted instead, this arm would
have failed to spawn at all — which is the point, since the ambient `PATH` is
what decides which binary receives the carrier.

#### Codex arm — built environment

| variable | in ambient | decision |
| --- | --- | --- |
| PATH | true | admitted-fixed |
| OPENAI_API_KEY | true | denied-hostile |
| CODEX_API_KEY | true | denied-hostile |
| OPENAI_BASE_URL | true | denied-hostile |
| CODEX_HOME | true | denied-broker-owned |
| HOME | true | denied-broker-owned |
| LANG | true | admitted-neutral |

```
Admitted variable names: LANG, PATH
exitCode=0 spawnFailure=false
attestation.route=subscription  attestation.validity=presence_only  attestation.exposedKeySources=[]
assertSubscriptionOnly: PASSED (no throw)
```

Two variables reached the child, neither a credential and neither a config home.
`CODEX_HOME` and `HOME` are `denied-broker-owned` rather than `denied-hostile`:
they were poisoned in this run, but the reason they are excluded is structural —
the broker owns its own config home, so passing either would misstate where the
credential lives, whatever the value.

#### Canary table for this run

| canary | outcome | evidence |
| --- | --- | --- |
| hostileAmbient | supported | injectedHostileCount=6; admittedHostileCount=0; route=subscription |
| credentialLifecycle | supported | scenario=baseline; carrierPresent=true; route=subscription; validity=presence_only |
| hostileAmbient | supported | injectedHostileCount=6; admittedHostileCount=0; route=subscription |
| credentialLifecycle | supported | scenario=baseline; carrierPresent=true; route=subscription; validity=presence_only |

Rows 1–2 are the Claude arm, rows 3–4 the Codex arm, in that order.
`admittedHostileCount=0` is a statement about what the child process actually
received, not about the recipe's self-report: `classifyHostileAmbient` inspects
the built `env` directly as well as the decision list. `credentialLifecycle`
runs as `scenario: "baseline"` here — the one lifecycle scenario that is an
ordinary healthy run rather than a declared abnormal label. The expiry and
revocation scenarios remain classifier inputs, never observations, because no
committed code can observe validity at all.
