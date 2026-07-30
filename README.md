# Heniek

Heniek is a local-first, durable control plane for software work performed by
subscription-backed coding-agent CLIs.

It treats one or more Git repositories as a logical Codebase, runs configurable
task pipelines through replaceable execution backends, and preserves artifacts,
questions, decisions, and delivery state outside the repositories it manages.

The canonical scope is [Product Specification v0.2](docs/product/product-spec-v0.2.md).
The original specification and naming work are retained under `docs/provenance`
and `docs/product` for auditability.

## Status

Private greenfield development. Nothing is published to npm and no open-source
license has been selected.

## Development

Requirements:

- Node.js 24
- pnpm 11

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

The repository bootstrap intentionally contains no Heniek product
implementation. Queue item Q001 introduces the first domain contracts and
generated JSON Schemas through the autonomous factory.
