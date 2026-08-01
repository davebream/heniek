# Evidence — subscription-only Claude Code and Codex engine profiles (ADR 0003)

Every table below is either rendered directly by this issue's own code
(`renderEnvironmentDiff`, `toMarkdownTable`) or is a redacted transcript of the
diagnostic shapes recorded in this issue's grounded observation table. No
credential value, no filesystem path from any host, and no prompt or model
output appears anywhere in this file — only variable **names**, presence
booleans, decisions, and small enumerated fields (`authMethod`, `apiProvider`,
route names) that this issue's diagnostics report directly.

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
ordinary neutral variables — then rendered by `renderEnvironmentDiff`:

| variable | in ambient | decision |
| --- | --- | --- |
| CLAUDE_CODE_OAUTH_TOKEN | true | admitted-carrier |
| CLAUDE_CONFIG_DIR | false | admitted-config-home |
| ANTHROPIC_API_KEY | true | denied-hostile |
| ANTHROPIC_AUTH_TOKEN | true | denied-hostile |
| ANTHROPIC_BASE_URL | true | denied-hostile |
| CLAUDE_CODE_USE_BEDROCK | true | denied-hostile |
| CLAUDE_CODE_USE_VERTEX | true | denied-hostile |
| PATH | true | admitted-neutral |
| LANG | true | admitted-neutral |
| SOME_OTHER_SERVICE_API_KEY | true | denied-unlisted |

`CLAUDE_CONFIG_DIR` shows `in ambient: false` — the ambient environment never
set it at all — and is still admitted, with the recipe's own dedicated config
home value, never an ambient one. An unrelated ambient variable this fixture
also carried (`SHLVL`) is absent from the table entirely: it is neither a
declared name nor credential-shaped, so it is excluded from the built
environment but not reported, exactly as `variables.ts` documents.

## Redacted environment diff — Codex, scenario F2 (brokered Codex, hostile config-home value)

Built from an ambient environment carrying the Codex subscription carrier, a
**hostile** `CODEX_HOME` value (as design scenario F2 injects), and every
hostile-catalogue name from `VARIABLE_POLICY.codex`:

| variable | in ambient | decision |
| --- | --- | --- |
| CODEX_CHATGPT_OAUTH_TOKEN | true | admitted-carrier |
| CODEX_HOME | true | admitted-config-home |
| OPENAI_API_KEY | true | denied-hostile |
| CODEX_API_KEY | true | denied-hostile |
| OPENAI_BASE_URL | true | denied-hostile |
| PATH | true | admitted-neutral |

`CODEX_HOME` shows `in ambient: true` — it *was* present, pointing at a
hostile location — and is still admitted, but with the recipe's own dedicated
config home, never the hostile ambient value. This is scenario F2's "hostile
names denied" property, achieved by override rather than by exclusion.

## Canary table

Rendered by `toMarkdownTable` from four representative canary runs: the
hostile-ambient scenario above (Claude scenario D, with the resulting
`indeterminate` attestation per F-1), scenario G3 (no carrier, ambient key
becomes the route), scenario B (no carrier, correctly reports no route), and
an expiry-scenario reading of scenario G1's diagnostic shape (fabricated
carrier, presence-only validity):

| canary | outcome | evidence |
| --- | --- | --- |
| hostileAmbient | degraded | injectedHostileCount=5; admittedHostileCount=0; route=indeterminate |
| credentialLifecycle | unsupported | scenario=carrier_absent; carrierPresent=false; route=api_key; validity=presence_only |
| credentialLifecycle | supported | scenario=carrier_absent; carrierPresent=false; route=none; validity=presence_only |
| credentialLifecycle | degraded | scenario=expiry; carrierPresent=true; route=subscription; validity=presence_only |

The first row is `degraded`, not `supported`: every hostile-catalogue
variable was correctly excluded (`admittedHostileCount=0`), but scenario D's
diagnostic also carries a visible `apiKeySource`, so `classifyClaudeBillingRoute`
correctly attests `indeterminate` rather than `subscription` — the isolation
held, the credential shape did not. This is the intended, honest outcome for
that specific input, not a failure of the recipe.

## Redacted diagnostic transcripts — scenarios A–G

Each row is the diagnostic shape this issue's grounded observation table
records, redacted to the fields `classifyClaudeBillingRoute` /
`classifyCodexBillingRoute` actually read. `apiKeySource`, where present, is
always a variable **name** the CLI reports as visible, never a value.

| scenario | diagnostic (redacted) | attested route |
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

### Codex classification, defensive patterns

Only the F1/F2 line was observed on the pinned host. The other two rows below
exercise `classifyCodexBillingRoute`'s defensive patterns against fixture
text; they are not confirmed against a real CLI transcript (see the ADR's
"Not covered" section):

| input text (fixture) | attested route |
| --- | --- |
| `Logged in using ChatGPT` (observed, F1/F2) | subscription |
| `Logged in using an API key` (defensive, not observed) | api_key |
| `Not logged in.` (defensive, not observed) | none |
