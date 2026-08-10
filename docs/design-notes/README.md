# Design notes

Explanatory notes on individual design decisions, written for readers who are
not tracking the ordered backlog.

These notes carry no authority. Normative scope lives in
[Product Specification v0.2](../product/product-spec-v0.2.md), and accepted
decisions with their evidence live in [`docs/adr`](../adr). Where a note and an
ADR disagree, the ADR is correct and the note is stale.

| Note | Covers |
|---|---|
| [A logical stage is not a model session](stage-is-not-a-session.md) | Why pipeline stage boundaries and provider session boundaries are separated, how segment fusion and continuation capsules work, and what the separation costs. |
