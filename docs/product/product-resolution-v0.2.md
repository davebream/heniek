# Heniek product-resolution record v0.2

- Date: 2026-07-30
- Canonical repository: `davebream/heniek`
- Superseded working name: Multi-Engine Coding Workflow Orchestrator

## Resolved decisions

Heniek is the fixed product, binary, and daemon name. `HENIEK_HOME` overrides
platform defaults; the fallback application home is `.heniek`.

The original Product Specification v0.1 remains unchanged as provenance.
Product Specification v0.2 reconciles the selected name, public interfaces,
reference hierarchy, and initial technical defaults without narrowing v1.

## Product versus factory

Heniek is the product. The temporary Windmill factory that builds it is external
infrastructure and may use Kombajn and Claudexor. Factory runtime state and
artifacts are prohibited from this repository.

Factory pull requests are non-draft and may auto-merge after required checks.
Heniek's own delivery behavior defaults to draft pull requests.
