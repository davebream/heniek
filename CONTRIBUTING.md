# Contributing to Heniek

Heniek is a public alpha. Issues are open for bug reports and design feedback;
the project is not yet accepting unplanned implementation work.

## Before opening an issue

Search existing issues first and choose the bug or design-feedback form. Keep
the report focused on one problem and include enough context for someone who
was not part of the original discussion.

Never put credentials, access tokens, private repository contents, or
unredacted Heniek/Claudexor doctor output in an issue. Replace sensitive values
with descriptive markers and reduce diagnostics to the smallest relevant,
redacted excerpt. Vulnerabilities belong in the private channel described in
[SECURITY.md](SECURITY.md), not in Issues.

## Before writing code

A maintainer must approve an issue for implementation before an external code
contribution starts. Add a short proposal to the issue covering the behavior,
scope, compatibility impact, and intended tests, then wait for explicit
agreement.

Pull requests without a linked, approved issue may be closed. Unsolicited
feature pull requests may also be closed during the alpha so that work stays
aligned with the ordered backlog and Product Specification v0.2. A merged pull
request does not create a support, release, or maintenance commitment.

## Development workflow

Heniek requires Node.js 24 and pnpm 11.13 or newer.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Keep changes narrowly scoped to the approved issue. Preserve provider-neutral
public contracts and keep provider DTOs inside execution-backend adapters.
Checked-in generated schemas and backlog files are compatibility and planning
artifacts: update them through their generators, not by hand. Do not add
runtime state, credentials, transcripts, or machine-local metadata to the
repository.

Before opening a pull request:

- run `pnpm check` on Node.js 24;
- add tests for changed behavior and regressions;
- explain compatibility or generated-artifact changes;
- remove secrets and redact logs, screenshots, and diagnostics;
- link the maintainer-approved issue.

## Participation standards

Be respectful, specific, and constructive. Critique ideas and behavior rather
than people. Respect privacy, do not publish another person's private data, and
do not use project spaces for harassment or discrimination. Maintainers may
edit, hide, or close content that violates these standards.

The project will adopt a formal code of conduct only after it has a private
moderation contact and a reliable handling process. Until then, do not include
sensitive personal details in public conduct reports.
