# Q031 bundled `careful` hash pins

Template: `packages/pipeline/bundled/careful.v1.yaml`

| Digest | Value |
|---|---|
| `sourceSha256` | `62cd4b2c09d02222dfbc7835125a0ecfb2a71f4df40110d08a02e60eafb627bf` |
| `normalizedGraphSha256` | `e81315848fe1fa427b4fc19d254d641ce6df40f175a541c3324c58e5a6cd565e` |

`loadBundledPipeline("careful", 1)` verifies both values. Public profiles are
`designer`, `critic`, `plan-reviewer`, `builder`, `code-reviewer`, and `verifier`.
The repair budget is two, permitting one identical-signature retry under ADR 0026.
