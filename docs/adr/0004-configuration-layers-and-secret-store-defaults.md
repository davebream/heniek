# 4. Configuration layers and secret-store defaults

- Status: accepted
- Date: 2026-08-01
- Issue: davebream/heniek#6 (Q005, T1-foundation, milestone M1)
- Spec anchors: §7 Global application home, §8 Configuration model, §24 Limits, retries and
  safeguards, §26.2/§27.1/§27.4 Security and privacy, §6.3 Secrets
- Evidence: [`evidence/0004-configuration-resolution-evidence.md`](evidence/0004-configuration-resolution-evidence.md)

## Context

Q005 gives Heniek three things nothing in the repository had before: one deterministic global
application home (§7), validated YAML configuration with a seven-layer precedence order and three
special merge rules (§8.2), and a platform-neutral secret store with a secure file fallback (§27.4,
§6.3). None of it is executed by a running product yet — the daemon, the CLI, and the state database
are later queue items — so this issue's job is to make the *foundation* correct and to record, here,
every decision the design left to the implementer.

## Decisions

### D1 — `yaml@2.9.0`, an enforcement layer over a tested parser, not a bespoke one

Spec §8.1's restricted subset (no custom tags, no executable values, duplicate keys rejected, merge
keys and anchors disabled, ambiguous scalars flagged, every document schema-validated) is a set of
*rejections* layered on top of ordinary YAML 1.2, not a different grammar. Writing a parser from
scratch to enforce it would mean re-implementing scalar resolution, block/flow collection parsing,
and source-position tracking — the exact surface where a hand-rolled parser is most likely to disagree
with every other YAML implementation on some edge case (block scalar chomping, flow-mapping
whitespace, the boolean/null word set) that this project would then have to discover the hard way.
`yaml@2.9.0` already gets that surface right and exposes exactly the hooks the restriction pass needs:
`parseAllDocuments` with `schema: "core"` (YAML 1.2, no YAML-1.1 implicit typing), `uniqueKeys: true`
(duplicate-key rejection built in), `keepSourceTokens: true` plus a `LineCounter` (source-located
diagnostics), and a retained AST (`visit`) for walking anchors, aliases, and tags directly rather than
trusting a parser option to have disabled them.

That last point is why `packages/config/src/yaml/restricted.ts` does not rely solely on `yaml`'s own
option surface: anchors, aliases, and non-core tags are additionally rejected by walking the parsed
AST after parsing, so a future `yaml` release that changes an option's default behaviour cannot
silently reopen one of §8.1's rejections. The dependency is scoped to exactly one package
(`@heniek/config`) via the workspace `catalog:` mechanism, and was proven installable under this
repository's pnpm supply-chain verification before being adopted (an additive lockfile delta, no
existing dependency touched).

### D2 — `secrets/` is an additive entry under the data root, not a narrowing of §7

§7's canonical application-home tree does not name a `secrets/` directory. Q005 needs one — §26.2 and
§27.4 both require credential material to stay out of `config/` (YAML), `artifacts/`, `exports/`, and
`backups/`, and nothing in §7's existing tree satisfies that on its own. `secretsDirectory` is added
to `@heniek/config`'s `home` module (`layout.ts`)'s `APPLICATION_HOME_LAYOUT` as a sibling of the other
data-root entries (`codebasesDirectory`, `artifactsDirectory`, …), materialised `0o700` by
`ensureApplicationHomeDirectories` exactly like every other directory entry. Nothing in §7's existing
tree is removed, renamed, or reinterpreted — every existing entry keeps its exact relative path — so
this is purely additive. It is deliberately *not* exposed on the `ResolvedConfigurationV1` /
`ApplicationHomeV1` public contracts as a named field: `packages/contracts/test/no-credential-fields.test.ts`
matches property names against a credential-shaped pattern that `secretsDirectory` trips, so the
contract's `paths` stays an open `string → string` record and the name lives only in
`@heniek/config`'s TypeScript layout type, where it costs nothing.

### D3 — arrays are atomic in the merge

Spec §8.2 says objects merge and a more specific layer wins; it does not say what "wins" means for an
array. Three readings were possible: element-wise merge by index, merge by some caller-supplied key,
or wholesale replacement. Index-wise merging has no defensible semantics for a *reordered* or
*shortened* list — is the third element of a five-element base array being overridden by, or is it
independent of, the third element of a two-element override array? Key-based merging would need a
schema-level notion of "identity" this generic layer-resolution pass has no way to know. Wholesale
replacement is the only reading with an unambiguous answer to AC2's question ("which layer produced
this value"): the whole array is a single leaf, one layer supplies it, and `configuration.value-overridden`
names exactly that layer against whichever earlier layer's array it replaced. `packages/config/src/layers/merge.ts`
implements this directly: `mergeJsonValue` merges key-wise only when *both* sides are plain objects, and
replaces wholesale (`return incoming`) for every other case, arrays included.

### D4 — the diagnostic-code vocabulary is open, never a closed enum

Every diagnostic this package emits (`Diagnostic.code` in `packages/config/src/diagnostics.ts`, and its
mirror in the `ResolvedConfigurationV1`/`ApplicationHomeV1` contracts) is a plain, non-empty string, never
a TypeBox/TypeScript union of literals. Codes grow additively as new rejection rules, policy checks, and
degenerate cases are discovered — this issue alone introduced over a dozen (`yaml.syntax-error` through
`configuration.type-changed`) — and a closed enum would force a schema version bump, and a matching
`SCHEMA_REGISTRY` change, for every single one of them, turning a purely additive change into a breaking
one for every downstream consumer. `packages/contracts/src/configuration/schemas.ts`'s inlined `Diagnostic`
schema types `code` as `Type.String({ minLength: 1 })` for exactly this reason, and documents it at the
declaration site so a future contributor does not "fix" it into an enum.

### D5 — the path-echoing rule, reconciled across both packages

`@heniek/config`'s `ApplicationHomeResolutionError` (`home/errors.ts`) and `@heniek/secrets`'s
`InsecureSecretStoreError`/`SecretStoreConfigurationError` (`store.ts`, `file-store.ts`) both handle
filesystem paths in error messages, and they agree on one rule, stated identically in both files: the
no-echo discipline applies specifically to **unvalidated environment input at resolution time**
(`HENIEK_HOME`, `XDG_*`, as read from `process.env` before this code has done anything to them) —
that input is attacker-influenced and may itself be sensitive (an operator's directory layout, a path
revealing local infrastructure) — never to a path that has already been *resolved* or that the caller
explicitly configured a store with. `ApplicationHomeResolutionError` never echoes the offending
`HENIEK_HOME`/`XDG_*` value; `ApplicationHomeEnsureError`, `InsecureSecretStoreError`, and
`SecretStoreConfigurationError` all *do* name the resolved path, because an unactionable "your secret
store is misconfigured" error with no path to investigate is worse than the low risk of an
already-resolved, caller-supplied path appearing in a log. The two packages state this identically
rather than each inventing their own convention, so a future contributor extending either one has one
rule to follow, not two that might silently drift apart.

### D6 — the secret store's verification cadence is deliberately asymmetric

`createFileSecretStore` (`packages/secrets/src/file-store.ts`) verifies the *directory* — symlink
check, ownership check, mode repair — exactly once per store instance, memoized by an internal `ready`
promise. It verifies each *entry file*'s mode on every single `read()`. This asymmetry is intentional,
not an oversight: once the directory is confirmed `0700` and owner-verified, nothing this process does
can widen it again without going through `chmod`/`rename` itself, so re-`stat`ing it on every operation
would buy near-zero additional safety for a real cost on every call. An individual entry file is both
cheap to re-check and the thing genuinely most likely to be touched out-of-band — a stray `chmod`, a
hand-placed replacement, a backup restored with the wrong mode — so paying the cost there, every read,
is where the verification budget belongs.

### D7 — the in-memory secret store has no on-disk representation, and therefore no permission surface

`createInMemorySecretStore` (`packages/secrets/src/memory-store.ts`) enforces the identical entry-name
validation (`assertValidEntryName`) the file adapter does, so a test written against the double cannot
pass against a laxer contract than production. It deliberately does **not** attempt to simulate the
file adapter's permission model (directory/entry modes, symlink/ownership checks, atomic-write
cleanup): the double holds every value in a `Map`, never touches the filesystem, and so has no
directory or file whose mode could ever be wrong — modelling one would be theatre, asserting a
property that is structurally impossible to violate. Parity between the two adapters is proven a
different way: `packages/secrets/test/contract.ts`'s `describeSecretStoreContract` is one shared test
suite, run once against each `factory()`, covering exactly the part of the contract that *is* common
to every `SecretStore` (name validation and its exact error type, read/remove/list/overwrite
semantics, the `SensitiveValue` round-trip). A duplicated pair of adapter-specific test files could
drift silently, each edited only when its own adapter changes; the shared suite cannot.

### D8 — the credential value-shape corpus is best-effort, enumerated by vendor, not exhaustive

`packages/secrets/src/patterns.ts`'s `CREDENTIAL_VALUE_PATTERNS` — the shapes `redactJson`/`redactText`
and the restricted-YAML guard use to catch a credential pasted under an innocuous key — is a fixed list
of known, *observed* vendor token formats (each of GitHub's five personal/OAuth/installation token
prefixes, each followed by an underscore; GitHub's fine-grained personal-access-token prefix, also
underscore-joined; the OpenAI/Anthropic/Stripe-style secret-key prefix, hyphen- or underscore-joined;
AWS `AKIA` access-key IDs; PEM private key headers; JWT-shaped base64url triples — see
`patterns.ts` itself for the exact, committed regular expressions, deliberately not reproduced
character-for-character here since this document is scanned by the same committed-ADR redaction guard
that covers ADR 0002/0003). It is explicitly **not** a general "looks like a secret"
heuristic (entropy scoring, length-only heuristics) and is not claimed to be exhaustive: a vendor
token format not on this list, or a credential with no recognisable shape at all, is not caught by
value-shape detection — only by the key-shape half of the guard (`looksLikeCredentialKey`), which
requires the surrounding key to be credential-named. One specific, named gap is carried forward
deliberately rather than silently: the AWS **secret access key** (the 40-character value that
accompanies an `AKIA…` access key id) has no distinguishing shape of its own — it is an arbitrary
base64-ish string — so no value-shape pattern exists for it, and a rule broad enough to catch it would
carry a high false-positive rate against ordinary opaque tokens. It is still caught when stored under a
credential-shaped key (`secretAccessKey`, `aws_secret_access_key`, …) via `looksLikeCredentialKey`, but
a bare AWS secret access key under an innocuous key name would pass both guards. This is recorded as a
known limitation, not treated as covered.

## Testing strategy

Every decision above is pinned by a regression test, not just documented: D3 by
`layers-resolution.test.ts`'s "replaces arrays wholesale" and "replaces a subtree with a scalar"
cases; D4 by the contracts' inlined `Diagnostic.code` schema (`Type.String`, no enum) and
`no-credential-fields.test.ts`; the prototype-pollution defence in `mergeJsonValue`/`applyEdits` (an
`Object.create(null)` accumulator, never bare `target[key] = …`) by `layers-resolution.test.ts`'s
`JSON.parse('{"__proto__":{"polluted":true}}')` cases, which assert both that no prototype anywhere is
polluted and that the `"__proto__"` key round-trips as an ordinary, if unusual, configuration key; D6
and D7 by `packages/secrets/test/file-store.test.ts` (directory-repair-once, entry-mode-refused-on-read)
and `contract.ts`'s shared suite run against both adapters; D8 by `redaction.test.ts`'s corpus tests,
which include the AWS-secret-access-key gap as an explicit, named non-catch case rather than an
implicit absence.

## Cross-platform evidence

CI (`.github/workflows/quality.yml`) runs on `ubuntu-latest`, and this issue's build session ran on
Linux. **macOS was not executed at any point in this work** — no command in this ADR or its evidence
file was run on a Mac, and no claim here should be read as a two-platform run. Two different kinds of
claim this issue makes are covered by two different kinds of evidence, deliberately not conflated:

- **Path/preference *determinism* across darwin and linux** (AC1) is proven by
  `packages/config/test/home-resolution.test.ts`'s injected-platform table: `resolveApplicationHome`
  is a pure function of `{ platform, env, homeDirectory }` with no read of `process.platform`/`os.homedir()`
  anywhere in its own body, so a `platform: "darwin"` row is exercised, asserted, and CI-checked exactly
  as thoroughly as a `platform: "linux"` row — the darwin branch (no XDG, `.heniek` fallback only) is
  real code under real test, executed on Linux hardware with a fabricated `platform` value, not skipped
  or approximated.
- **Filesystem *permission behaviour*** (`ensureApplicationHomeDirectories`'s `0700`/repair/refuse
  logic, the secret store's `0700`/`0600` modes) rests on POSIX mode bits, which darwin and linux share
  identically at the level this code operates on (`mkdir`/`chmod`/`lstat` mode arguments, `S_IRWXG`/
  `S_IRWXO` bit clearing). This is a *platform-sharing* argument, not a *tested-on-both* one: the
  evidence file's `stat -c '%a'` output was captured on this Linux session and is not claimed to have
  been reproduced on a Mac.

## Consequences

- `@heniek/config` depends on `@heniek/secrets` one-way; `@heniek/secrets` has no reverse dependency —
  the file secret store adapter takes an explicit `directory` and the helper that derives one from a
  resolved application home (`defaultSecretStoreDirectory`) lives in `@heniek/config`, not the other way
  round.
- `resolveConfiguration` is a pure function with no implicit defaults: a caller that wants the spec's
  stated `built-in-defaults` (§24's limits, §27.1's privacy block) includes `HENIEK_BUILT_IN_DEFAULTS`
  in its own `documents` array, and one that wants the three special merge rules enforced passes
  `HENIEK_BUILT_IN_CONFIGURATION_POLICY`. Neither is force-injected by `resolveConfiguration` itself —
  doing so would make every resolution, including ones deliberately constructed to test one isolated
  pointer, silently carry the full limits/privacy block whether the caller asked for it or not, and
  would make a caller that *also* supplies its own `built-in-defaults` document (as several tests
  legitimately do) see that document compared against an implicit second copy of itself.
- Two additive, non-breaking public contracts (`ApplicationHomeV1`, `ResolvedConfigurationV1`) are
  added under `packages/contracts/src/configuration/`; the pinned manifest in
  `packages/conformance/test/contracts-compatibility.test.ts` moves from 12 to 14 schemas, with the
  existing twelve hashes byte-identical — the deliberate versioning act AC4 asks for.
- No SQLite schema (Q006), no profile/account/pipeline document schemas (Q014/Q024), no worker
  environment scrubbing (Q022), no export-bundle construction (Q055), and no macOS Keychain or cloud
  secret-manager adapter — the `SecretStore` port is shaped so one can be added later without a
  breaking change, but none is implemented here.
