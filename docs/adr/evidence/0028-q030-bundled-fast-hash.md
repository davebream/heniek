# Q030 bundled `fast` hash pins

Template path: `packages/pipeline/bundled/fast.v1.yaml`

Lookup key: `fast.v1` via `loadBundledPipeline("fast", 1)`.

Pinned digests (generation-time, embedded in
`packages/pipeline/src/bundled/manifest.generated.ts`):

| Digest | Value |
|---|---|
| `sourceSha256` | `89fe1b201d9590376080aac94abc474640c9034a73f1464768e31ad07c4afacb` |
| `normalizedGraphSha256` | `8650b9e6d60a5cd31b8f261189abaebb2b7948fc1119579dc547e4cc534b469b` |

Notes:

- `sourceSha256` hashes the exact bundled YAML bytes on disk.
- `normalizedGraphSha256` hashes `renderPipelineGraph` output after parse with
  public profiles `task-owner` and `reviewer`.
- Repair budget is `2` so one identical-signature validation repair is allowed
  under ADR 0026's `identicalSignatureCount >= budget` ceiling (see ADR 0028 D6).
- Golden coverage: `packages/pipeline/test/bundled-fast.test.ts`.
