# 22. Pipeline definition schema, parser, and diagnostics

- Status: accepted
- Date: 2026-08-09
- Issue: davebream/heniek#25 (Q024 — YAML pipeline schema, parser and diagnostics, T1-foundation,
  milestone M3, closes it)
- Spec anchors: §8.1 restricted YAML subset, §8.2 configuration layers, §8.3 human-readable source
  of truth, §14.1 arbitrary declarative graph, §14.2 first-class stage types, §14.3 illustrative
  stage definition, §14.4 conditional transitions, §14.5 execution modes, §15.2 segment fusion,
  §15.3 smart continuation, §16.2 hybrid mutability, §19.5 stage completion contract, §19.6
  validation failure policy, §24 limits and safeguards
- Evidence:
  [`evidence/0022-q024-command-results.md`](evidence/0022-q024-command-results.md),
  [`evidence/0022-q024-pipeline-schema.md`](evidence/0022-q024-pipeline-schema.md),
  [`evidence/0022-q024-diagnostic-corpus.md`](evidence/0022-q024-diagnostic-corpus.md)

## Context

Milestone M3 is the pipeline runtime, and nothing in this repository could read a pipeline.
`pipelinesDirectory` has existed in the application-home layout since Q009 and `pipeline-template`
has been a configuration layer since Q014, but there was no document format, no parser, and no
graph contract — so the directory was a place to put files nothing could open.

Q024 is the reading layer and nothing else. Q025 schedules the graph, Q026 runs its stages, Q030
and Q031 ship bundled `fast` and `careful` templates, and Q051 exposes
`heniek pipeline validate`. All four consume what this issue produces, so the deliverable is a
pure library: YAML in, normalized graph JSON plus source-located diagnostics out. No scheduler, no
runner, no CLI, no filesystem.

Two properties the issue asks for shape everything below. **Equivalent YAML must normalize to
byte-identical graph JSON**, because the graph is what later stages diff, store, and replay — and a
graph that changes when a comment moves is not a diff target. And **every rejection must name the
file, the path, the line and column, the violated rule, and the suggested correction**, because a
pipeline is hand-authored configuration and a parser that says "invalid" without saying "write this
instead" moves the cost from the tool onto every author.

## Decision

### D1 — A new `packages/pipeline`, not a module inside `@heniek/config`

`@heniek/config` owns configuration layering, home resolution, profiles, and the restricted YAML
subset. Pipelines reuse the last of those and none of the rest.

`@heniek/pipeline` depends on `@heniek/config` for the YAML subset, the diagnostic record, the
canonical serialiser, and the duration parser; on `@heniek/contracts` for the schemas; and on
`@heniek/secrets` for redaction. Q025's scheduler lands as a sibling rather than as more surface on
a package that already carries four concerns.

*Rejected:* a `src/pipeline/` module inside `@heniek/config`. It would have saved a `package.json`
and made the configuration package the home of a graph model that has nothing to do with §8.2's
layers.

### D2 — Two contracts: the authored document and the normalized graph

`PipelineDefinition/v1` is the YAML a person writes. `PipelineGraph/v1` is what the parser
produces. They are separate because they change for different reasons: the first is constrained by
what is comfortable to write, the second by what a scheduler needs to consume.

`versioned()` gives the definition both halves of the issue's "explicit schema version"
constraint — a required `schemaVersion: 1` literal and `additionalProperties: false`, which turns a
misspelled key into a located diagnostic rather than a silently ignored line. The same schema
object is what `loadRestrictedYamlDocument` validates against, so validating a pipeline file and
validating the published contract are one operation rather than two that can drift.

**The graph carries no source positions.** This is the load-bearing decision behind byte-identity:
a line number is a property of a file, not of a pipeline. Positions live only in diagnostics, which
are about a file by definition.

A third contract, `PipelineValidationResult/v1`, pairs an optional graph with the diagnostics.
`graph` is absent exactly when an error was raised, so no consumer has to decide whether a
partially-built graph is safe to use.

### D3 — Three edge spellings, one canonical edge list

`needs`, per-stage `transitions`, and a top-level `edges` list are three surfaces for one relation.
The redundancy is the specification's, not an invention: §14.3 and §15.2 write plain `needs`
sequences, §14.4 writes `when`/`then`, and a generated one-off graph (§14.1) is easiest to emit as
explicit edges. All three normalize into one list, sorted by `(from, to, canonical condition)`.

Identical duplicates collapse silently — the same relation written twice is still one relation, and
this is what lets a document declare `needs: [design]` *and* an explicit `design → critique` edge
without producing a different graph than either alone. Two edges sharing endpoints but differing in
condition are a genuine contradiction and are reported, because leaving both would make a scheduler
guess.

### D4 — A bounded condition grammar compiled to a flat AST

§14.4's deterministic conditions compile to data, never to code. The grammar admits dotted state
references, JSON scalars, six comparison operators, `&&`/`||`/`!`, and parentheses — no arithmetic,
no indexing, no function calls, no interpolation. §8.1 forbids executable values, and the cheapest
way to keep that promise is for the language to have nothing to execute. Four ceilings bound the
compiled shape: source length, node count, path segments, and nesting depth.

Comparison is deliberately non-associative. `a < b < c` reads as a range in every language a person
is likely to be thinking of and means something else in all of them, so it is a syntax error rather
than a silent `(a < b) < c`.

The compiled form is an **index-addressed flat array**, not a nested tree:

```json
{
  "kind": "expression",
  "nodes": [
    { "kind": "path", "path": ["verify", "blockingFindings", "length"] },
    { "kind": "literal", "value": 0 },
    { "kind": "compare", "operator": "gt", "left": 0, "right": 1 }
  ],
  "root": 2
}
```

A nested tree needs `Type.Recursive`, which mints its own `$id` nested inside whatever schema
embeds it — the duplicate-`$id` hazard `contracts/src/configuration/schemas.ts` documents at length
for `Diagnostic`. The flat form has no recursion to declare, serialises to bytes that depend only
on the expression's structure, and costs a consumer one index lookup per child. Children are always
emitted before their parent, so `root` is the last node and a consumer may evaluate the array
front-to-back with no recursion at all.

Operators are spelled as words (`gt`, not `>`) because the graph is JSON that other tools read, and
a symbolic operator invites "just eval it".

### D5 — Profile references are checked only against a list the caller supplies

Intra-document references are always checked: a `needs` entry names a real stage, a read is
satisfied by an ancestor's write, the graph is acyclic, every stage is reachable.

Profiles are different. They live in other files, resolved through §8.2's layers against a
capability catalogue discovered at run time. `parsePipelineDocument` takes an optional
`knownProfileIds`; supplied, an unknown profile is an error, omitted, the parser says nothing. Every
place a profile can appear is covered by the same check — the stage's worker, an evaluator
condition, a `verdict` completion requirement, and a repair delegate.

*Rejected:* resolving profiles through `@heniek/config`'s resolver during parsing. It would make
the same pipeline file valid on one machine and invalid on another, drag capability discovery into
a parsing library, and destroy the byte-identity guarantee, since the output would then depend on
machine state. Deciding whether a profile exists belongs to whoever *runs* the pipeline.

### D6 — A `suggestion` field on the pipeline diagnostic, inlined rather than shared

Acceptance criterion 2 requires a suggested correction, and `@heniek/config`'s `Diagnostic` has no
field for one. `PipelineDiagnostic` is that record plus `suggestion`, declared in the pipeline
family.

*Rejected:* adding the field to the shared record. That object is embedded verbatim in
`ApplicationHome/v1`, `ResolvedConfiguration/v1`, and both `ResolvedProfile` versions, all closed
with `additionalProperties: false` — so widening it would either move four published digests or let
a configuration diagnostic carrying a `suggestion` fail validation against the very contract
supposed to carry it.

Diagnostics inherited from the YAML and schema layers get their suggestion from a table: one entry
per YAML-subset code, and a pointer-keyed table for schema violations that walks up to the nearest
ancestor with advice. The walk deliberately stops *above* the document root — falling through to it
would answer "what should `/nothing/like/this` be?" with "a pipeline document is a mapping", which
is true and useless.

### D7 — Rules a schema cannot express, checked over the whole graph in one pass

Nodes, edges, profiles, conditions, policies, limits, modes, and outputs are all validated. The
rules worth naming here are the ones that are judgement calls rather than mechanics:

- **A stage limit looser than the pipeline limit is an error**, not a clamp. §24 says the strictest
  applicable limit wins, so a looser stage limit is not merely ineffective — it reads like a licence
  the run will not grant.
- **A read must be satisfied by an ancestor's write**, where a write of `artifacts.design` satisfies
  a read of `artifacts.design.selected` (§14.3 reads exactly that pair). `task.*` is always
  available, because the run supplies it, and is never writable.
- **Two stages writing the same target are fine when one runs after the other** — §16.2's active
  artifact alias is mutable, so a later stage may supersede an earlier one's output. Two stages that
  may run *concurrently* writing the same target is a race whose winner depends on scheduling, which
  is exactly what a deterministic control plane must not have.

Every rule reports through one reporter, which attaches the source path and resolves the pointer to
a position, so a rule cannot be written that forgets to locate itself. The normalizer and the
validator both run even when the normalizer found a broken condition, so an author sees every
problem in one pass rather than one per attempt.

**Known limitation.** An error *inside* a condition expression reports the position of the YAML
scalar holding it, with the character offset in the message and a caret excerpt in the suggestion.
Resolving a column inside a folded scalar is not attempted: the YAML layer locates nodes, not
positions within them, and a fabricated column would be worse than an honest one plus a caret.

### D8 — No defaults are invented for §24's limits

`mode` and `optional` are resolved to concrete values on every stage, so a pipeline that sets the
mode once at the top and one that repeats it on every stage are the same graph. Limits are **not**
defaulted. Built-in defaults live in `@heniek/config`'s `HENIEK_BUILT_IN_DEFAULTS` and merge through
§8.2's layer order, where "the strictest applicable hard limit wins" can be evaluated against every
layer. Inventing a default at parse time would silently promote a template's silence into a value
that outranks a global default.

`session` is likewise absent rather than defaulted: §15.2 expresses "no explicit fresh-session
boundary" by the *absence* of a declaration, so the vocabulary has no third `auto` member that
could disagree with the field being missing.

### D9 — Only spec-sourced vocabulary

Every field in `PipelineDefinition/v1` traces to Product Specification v0.2. Where §19.5 lists seven
completion requirements in prose, the schema declares a closed set of eight forms covering them
(artifact and schema/section checks split), because a requirement the runtime cannot evaluate is
worse than no requirement: it reads like a guarantee and enforces nothing, which is the exact
failure §19.5's "a worker's done claim is evidence, not authority" exists to prevent.

Nothing was added because it seemed useful. `command` stages declare `argv`, `cwd`, and `env`
because a graph must be complete enough to schedule; the execution semantics belong to Q026. `env`
needs no credential guard of its own — the restricted-YAML layer already refuses credential-shaped
entries on every mapping pair before this schema sees the document, and a second, weaker guard would
only invite disagreement between the two.

## Consequences

- Q025 receives a graph it can schedule without re-parsing anything: stages and edges sorted,
  defaults resolved, durations in milliseconds, conditions compiled to an array it evaluates with an
  index walk.
- Q030 and Q031 can author bundled templates against a published schema, and a template that drifts
  from the contract fails `pnpm check` rather than at run time.
- Q051's `heniek pipeline validate` is a thin renderer over `parsePipelineDocument`; the three
  output forms it needs — canonical graph JSON, the validation-result contract, and the
  human-readable listing — already exist.
- Adding a stage type, a completion requirement, or an operator is a contract change with a digest,
  by design. §14.2's "no public third-party stage implementation API exists in v1" is enforced by
  the closed vocabulary rather than stated in prose.
- The corpus is the review surface. Expected files are regenerated with
  `tsx test/helpers/refresh-expected.ts` and read as a diff — deliberately a separate command rather
  than a flag on the test suite, so the command that checks the bytes can never be the command that
  rewrites them.

## Defects found while implementing, and what pins them

Each has a case in `packages/pipeline/test/regressions.test.ts`.

| Defect | Why nothing caught it |
|---|---|
| A stage `type` outside the six v1 values produced **seven** diagnostics — one per failed union branch plus the `anyOf` summary — with one identical correction repeated seven times. | Every individual diagnostic was correct: right position, right rule, right suggestion. Only the *set* was wrong, and no assertion looked at the set. Branch explanations of a union are now collapsed into the summary, and the summary's Ajv wording is rewritten into a sentence. |
| A read in an unknown namespace was reported twice: as an unknown namespace, and again as "nothing writes it". | The second is true, trivially, of anything in a namespace that does not exist. It buried the diagnostic that named the actual mistake. |
| The pointer-suggestion walk always terminated at the document root, so an unrecognised pointer was answered with "a pipeline document is a mapping with schemaVersion, id, and stages" and the generic fallback was unreachable. | Both branches returned a plausible string, so nothing looked wrong from the outside. |
| Stage types were interpolated after a bare "A", producing `A "agent" stage`. | Cosmetic, and exactly the kind of cosmetic that makes a tool read as unmaintained. |
