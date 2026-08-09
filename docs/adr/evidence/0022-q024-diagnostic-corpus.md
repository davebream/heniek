# Q024 — diagnostic corpus snapshot

Point-in-time rendering of every rejected document in the golden corpus,
produced by `renderPipelineDiagnostics`. The authoritative, test-enforced
copies live in `packages/pipeline/test/expected/invalid/`; `corpus.test.ts`
byte-compares against them, so this file is a readable snapshot rather than a
second source of truth.

Every entry shows the four things acceptance criterion 2 requires — file,
line and column, JSON pointer, violated rule — plus the suggested correction.

## Rejected documents

### `anchors-and-aliases.yaml`

```text
packages/pipeline/test/corpus/invalid/anchors-and-aliases.yaml:7:9  error  yaml.alias-not-supported
  Alias nodes are not supported by the restricted YAML subset.
  → Write the value out in full. Aliases (`*name`) are outside the restricted YAML subset, so a pipeline file always reads the same way it runs.

packages/pipeline/test/corpus/invalid/anchors-and-aliases.yaml:4:3  error  yaml.anchor-not-supported
  Anchors are not supported by the restricted YAML subset.
  → Remove the anchor (`&name`) and write the value out in full; share repeated configuration through a profile instead.

packages/pipeline/test/corpus/invalid/anchors-and-aliases.yaml:7:5  error  yaml.merge-key-not-supported
  The "<<" merge key is not supported by the restricted YAML subset.
  → Remove the `<<` merge key and write the merged keys out in full.
```

### `broken-expression.yaml`

```text
packages/pipeline/test/corpus/invalid/broken-expression.yaml:10:23  error  pipeline.expression-invalid
  Condition expression is incomplete. (at character 33 of the condition)
  at /stages/0/transitions/0/when/expression
  → Fix the condition at the marked character:
  → verify.blockingFindings.length >
  →                                 ^
```

### `conflicting-writes.yaml`

```text
packages/pipeline/test/corpus/invalid/conflicting-writes.yaml:19:14  error  pipeline.conflicting-writes
  "left" and "right" both write "artifacts.report" and may run at the same time.
  at /stages/2/writes/0
  → Order the two stages so one runs after the other, or have them write different targets.

packages/pipeline/test/corpus/invalid/conflicting-writes.yaml:19:32  error  pipeline.write-not-allowed
  "task.current" is supplied by the run, so a stage cannot write it.
  at /stages/2/writes/1
  → Write to `artifacts.` or `decisions.` instead.
```

### `contradictory-edges.yaml`

```text
packages/pipeline/test/corpus/invalid/contradictory-edges.yaml:9:9  error  pipeline.duplicate-edge
  "gate" leads to "ship" more than once, under different conditions.
  at /stages/0/transitions/0
  → Combine them into one edge — use `||` inside a single expression if either condition should allow the transition.
```

### `credential-in-document.yaml`

```text
packages/pipeline/test/corpus/invalid/credential-in-document.yaml:9:18  error  yaml.sensitive-value-not-allowed
  The value for "api_key" looks like a credential and is not allowed in YAML configuration — store it with the secret store and reference it by name instead.
  → Move the value into the secret store and reference it by name; credentials never belong in a pipeline file.
```

### `cycle.yaml`

```text
packages/pipeline/test/corpus/invalid/cycle.yaml:4:5  error  pipeline.cycle
  These stages depend on each other in a cycle: a → b → c → a.
  at /stages/0
  → Break the cycle by removing one dependency; a pipeline is a DAG, so no stage may wait for a stage that waits for it.

packages/pipeline/test/corpus/invalid/cycle.yaml:4:3  error  pipeline.no-entry-stage
  Every stage depends on another stage, so the pipeline has nowhere to start.
  at /stages
  → Leave at least one stage with no `needs` and no incoming edge.
```

### `duplicate-stage-id.yaml`

```text
packages/pipeline/test/corpus/invalid/duplicate-stage-id.yaml:4:5  error  pipeline.duplicate-stage-id
  Stage id "twice" is declared 2 times.
  at /stages/0
  → Give each stage a unique id; a later stage referring to this one cannot say which it means.
```

### `missing-schema-version.yaml`

```text
packages/pipeline/test/corpus/invalid/missing-schema-version.yaml:2:1  error  configuration.schema-violation
  (root) must have required property 'schemaVersion'
  → A pipeline document is a mapping with at least `schemaVersion`, `id`, and `stages`.
```

### `read-not-produced.yaml`

```text
packages/pipeline/test/corpus/invalid/read-not-produced.yaml:13:9  error  pipeline.read-not-produced
  "artifacts.design" is written by "sibling", which "second" does not depend on.
  at /stages/1/reads/0
  → Add a dependency so "second" runs after "sibling".

packages/pipeline/test/corpus/invalid/read-not-produced.yaml:15:9  error  pipeline.unknown-state-namespace
  "session.token_budget" starts with "session", which is not part of the canonical run state.
  at /stages/1/reads/2
  → Read from `task.`, `artifacts.`, or `decisions.`.
```

### `stage-shape-mismatches.yaml`

```text
packages/pipeline/test/corpus/invalid/stage-shape-mismatches.yaml:9:5  error  pipeline.command-required
  A "command" stage must declare what to run.
  at /stages/1/command
  → Add `command: { argv: [...] }`, for example `argv: [pnpm, test]`.

packages/pipeline/test/corpus/invalid/stage-shape-mismatches.yaml:23:20  error  pipeline.delegate-target-not-allowed
  A "pause" repair strategy never delegates, so `delegate_to` would be ignored.
  at /stages/2/on_validation_failure/delegate_to
  → Remove `delegate_to`, or set `strategy: delegate`.

packages/pipeline/test/corpus/invalid/stage-shape-mismatches.yaml:19:21  error  pipeline.limit-not-stricter
  Stage "loose_limits" may run for 14400000ms, longer than the whole pipeline's 1800000ms.
  at /stages/2/limits/max_duration
  → Shorten the stage limit so it fits inside `limits.max_pipeline_duration`.

packages/pipeline/test/corpus/invalid/stage-shape-mismatches.yaml:18:28  error  pipeline.limit-not-stricter
  Stage "loose_limits" allows 9 repair attempts, more than the pipeline limit of 2.
  at /stages/2/limits/max_repair_attempts
  → Lower it to 2 or below — the strictest applicable limit is the one that applies.

packages/pipeline/test/corpus/invalid/stage-shape-mismatches.yaml:11:14  error  pipeline.profile-not-allowed
  A "command" stage does not run a worker, so a profile would never be used.
  at /stages/1/profile
  → Remove `profile`, or change the stage type to `agent` if it should run a worker.

packages/pipeline/test/corpus/invalid/stage-shape-mismatches.yaml:7:5  error  pipeline.profile-required
  An "agent" stage runs a worker, so it must name a profile.
  at /stages/0/profile
  → Add `profile: <name>`, for example `profile: sol-critic`.
```

### `unknown-dependency.yaml`

```text
packages/pipeline/test/corpus/invalid/unknown-dependency.yaml:10:13  error  pipeline.unknown-stage-reference
  No stage with id "frist" is declared.
  at /stages/1/needs/0
  → Declare a stage with id "frist", or point this dependency at an existing stage.
```

### `unknown-key.yaml`

```text
packages/pipeline/test/corpus/invalid/unknown-key.yaml:4:5  error  configuration.schema-violation
  /stages/0 must NOT have additional properties
  at /stages/0
  → A stage is a mapping with at least `id` and `type`.
```

### `unknown-stage-type.yaml`

```text
packages/pipeline/test/corpus/invalid/unknown-stage-type.yaml:5:11  error  configuration.schema-violation
  /stages/0/type does not match any of the accepted alternatives.
  at /stages/0/type
  → Use one of the v1 stage types: agent, command, approval, integration, verify, publish.
```

### `unreachable-stage.yaml`

```text
packages/pipeline/test/corpus/invalid/unreachable-stage.yaml:13:5  error  pipeline.cycle
  These stages depend on each other in a cycle: island → island_two → island.
  at /stages/2
  → Break the cycle by removing one dependency; a pipeline is a DAG, so no stage may wait for a stage that waits for it.

packages/pipeline/test/corpus/invalid/unreachable-stage.yaml:13:5  error  pipeline.unreachable-stage
  Stage "island" cannot be reached from any starting stage.
  at /stages/2
  → Connect "island" to the graph with `needs` or an edge, or remove it.

packages/pipeline/test/corpus/invalid/unreachable-stage.yaml:16:5  error  pipeline.unreachable-stage
  Stage "island_two" cannot be reached from any starting stage.
  at /stages/3
  → Connect "island_two" to the graph with `needs` or an edge, or remove it.
```

## Equivalence groups

- `conditional`: 2 spellings → byte-identical (1991 bytes)
  - `packages/pipeline/test/corpus/equivalent/conditional/a-transitions.yaml`
  - `packages/pipeline/test/corpus/equivalent/conditional/b-edges-respaced.yaml`
- `linear`: 3 spellings → byte-identical (1111 bytes)
  - `packages/pipeline/test/corpus/equivalent/linear/a-needs.yaml`
  - `packages/pipeline/test/corpus/equivalent/linear/b-edges.yaml`
  - `packages/pipeline/test/corpus/equivalent/linear/c-mixed.yaml`
