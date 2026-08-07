# Heniek product-resolution record v0.2

- Date: 2026-07-30
- Updated: 2026-08-07
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

## Open-source core and hosted services

The local Heniek product is licensed under MIT. This includes the daemon, CLI,
SDKs, public protocols, TUI, and local dashboard. Package manifests remain
private until a separate publication decision is made.

A future hosted control plane, hosted GUI, or cloud-only features may be
operated commercially under separate terms. Those possible hosted components
are not part of the current repository or product commitment.

Selecting MIT does not constitute a v1 release, npm publication, standalone
binary release, hosted-service launch, or production-support promise. Any
relicensing, package publication, or hosted-service terms require a new explicit
product decision.
