# Q024 — generated pipeline JSON Schema

## What was added

Three contracts, by pure addition. Every one of the 106 schemas that existed
before this change keeps its recorded `sha256`, and no existing
`*.schema.json` file was rewritten.

| Contract | Generated file | `sha256` |
|---|---|---|
| `heniek://contract/PipelineDefinition/v1` | [`packages/contracts/generated/PipelineDefinition.v1.schema.json`](../../../packages/contracts/generated/PipelineDefinition.v1.schema.json) | `8f13880f0509468a85ed5b7e8701e8bdddf00fae640e8c7b3fc4f24b5dec14a1` |
| `heniek://contract/PipelineGraph/v1` | [`packages/contracts/generated/PipelineGraph.v1.schema.json`](../../../packages/contracts/generated/PipelineGraph.v1.schema.json) | `16307f658328ededa1998ef22706004b4bce06247d6775df0361616dd7dfa3b1` |
| `heniek://contract/PipelineValidationResult/v1` | [`packages/contracts/generated/PipelineValidationResult.v1.schema.json`](../../../packages/contracts/generated/PipelineValidationResult.v1.schema.json) | `19a3183a732618aa3db2cb37aabe40fd923fef52f487c20b3901a6131cf5d1d4` |

## Compatibility

```console
$ pnpm --filter @heniek/contracts generate
$ git diff --numstat packages/contracts/generated/
18      0       packages/contracts/generated/manifest.json

$ python3 -c "import json; print(len(json.load(open('packages/contracts/generated/manifest.json'))['schemas']))"
109
```

18 insertions, 0 deletions: the manifest grew by exactly the three new entries
and nothing else moved. The registry goes 106 → 109, and
`packages/conformance/test/contracts-compatibility.test.ts` pins the new count
and the three new digests alongside the 106 unchanged ones.

## The one compatibility decision

A pipeline diagnostic carries a `suggestion`; the configuration family's
diagnostic does not. Adding the field to the inlined `Diagnostic` in
`packages/contracts/src/configuration/schemas.ts` would have been the smaller
diff and was rejected: that object is embedded in `ApplicationHome/v1`,
`ResolvedConfiguration/v1`, `ResolvedProfile/v1`, and `ResolvedProfile/v2`, so
one new optional field would move four published digests to serve one new
consumer. The pipeline family inlines its own copy instead.

## Definition versus graph

`PipelineDefinition/v1` is the authored YAML document; `PipelineGraph/v1` is
its normalized form. They are separate contracts because they answer different
questions and change for different reasons — the first is an authoring surface
constrained by what a person should be able to write, the second is a
consumption surface constrained by what a scheduler needs.

The graph carries **no source positions**. That is what makes
"equivalent YAML normalizes to byte-identical graph JSON" achievable: a line
number is a property of a file, not of a pipeline, and embedding one would
make two identical pipelines differ because a comment moved. Positions live
only in diagnostics, which are about a file by definition.

## Normalization, demonstrated

```console
$ node --version
v24.19.0
```

Three spellings of one pipeline — `needs`, explicit `edges`, and a mixture
with reordered stages, quoted scalars, flow collections, comments, spelled-out
defaults, and a duplicate write — all render to the same 1111 bytes:

```text
packages/pipeline/test/corpus/equivalent/linear/a-needs.yaml
packages/pipeline/test/corpus/equivalent/linear/b-edges.yaml
packages/pipeline/test/corpus/equivalent/linear/c-mixed.yaml
→ byte-identical (1111 bytes)
```

Two spellings of a conditional pipeline — `transitions` versus top-level
`edges`, with the condition respaced from
`gate.blockingFindings.length > 0 && !gate.skipped` to
`gate.blockingFindings.length>0&&!gate.skipped` — render to the same 1991
bytes:

```text
packages/pipeline/test/corpus/equivalent/conditional/a-transitions.yaml
packages/pipeline/test/corpus/equivalent/conditional/b-edges-respaced.yaml
→ byte-identical (1991 bytes)
```

The recorded bytes are checked in under
`packages/pipeline/test/expected/`, and `corpus.test.ts` compares against them
on every run. The seeded property suite makes the same claim over generated
input rather than over the documents someone thought to write down.
