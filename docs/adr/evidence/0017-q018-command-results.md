# Q018 Cursor spike and conformance report

Recorded on 2026-08-07 from a working tree based on commit
`480211e601391fdb45fc86dbae3a6acc0a214b9a` (Q017 on `main`).

## Runtime selection and authentication

| Fact | Observed value |
| --- | --- |
| Claudexor protocol | `/v2`, major `3`; compatible handshake |
| Claudexor engine | `3.1.2`, `bb5efee24132aa3d65e417040df201e08da44c8c` |
| Cursor CLI (approved pin, used for all decisive evidence) | `2026.06.12-01-15-52-7244546` |
| Cursor CLI currently on `PATH` | `2026.08.04-aaa8809` (self-installed mid-spike) |
| Model / effort | `Composer 2.5` / not selectable (`effortLevels: []`) |
| Subscription tier | `Pro` |
| Requested auth route | `subscription` + `native_session` |
| Attested auth route | native Cursor session: available and passed |
| API-key fallback | removed from the environment; run reported `apiKeySource: "login"` |
| Credential profile forwarded | none — Cursor routes as a native session |

The Claudexor observation used the loopback control API's bearer authentication locally. No token,
account material, login email, run identifier, prompt transcript, or control URL is recorded in this
repository.

## Clean-checkout acceptance gate

```text
$ node --version
v24.19.0

$ pnpm --version
11.13.0

$ .../versions/2026.06.12-01-15-52-7244546/cursor-agent --version
2026.06.12-01-15-52-7244546

$ pnpm install --frozen-lockfile
Done in 2s using pnpm v11.13.0

$ pnpm check
Test Files  116 passed | 3 skipped (119)
Tests       1727 passed | 9 skipped (1736)
```

`pnpm check` also completed formatting, backlog integrity, generated-contract, conformance, and
TypeScript checks successfully. No generated contract or conformance artifact changed: Cursor
needed no new schema.

## Pinned Claudexor build

```text
$ git clone https://github.com/razzant/claudexor
$ git checkout bb5efee24132aa3d65e417040df201e08da44c8c
$ git describe --tags
v3.1.2

$ pnpm install --frozen-lockfile && pnpm build
Tasks:    30 successful, 30 total
```

## Cursor CLI spike observations

| Question | Observation on the pinned build |
| --- | --- |
| Headless | `-p --output-format stream-json` with `--trust`; `--mode ask\|plan` for read-only |
| Frame taxonomy | `system/init`, `user`, `thinking/delta`, `thinking/completed`, `assistant`, `result/success` |
| Session identity | 36-character `session_id` on every frame; `create-chat` also mints one |
| Resume | `--resume <sessionId>` returned the **same** session id; the resumed turn reloaded prior context |
| Questions | no interaction frames in headless mode; harness reports `interactive: false` |
| Usage | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` on the result frame; no cost figure on the subscription route |
| Cancellation | `SIGTERM` ends the run; launcher exits `143` |
| Errors | `is_error` plus a non-`success` `result.subtype` |
| Billing route | `apiKeySource: "login"` with `CURSOR_API_KEY` removed |

Session material lives in `~/.cursor/chats/<workspace-hash>/<chatId>/` as a SQLite store plus a
metadata file; the credential itself is keychain-backed rather than file-backed.

## Auth-readiness canaries

| Canary | Result |
| --- | --- |
| Handshake against the pinned build | compatible; engine and sha matched the pin |
| `cursor` auth-readiness, real `HOME` | `native_session` / `available` / `passed` |
| `cursor` auth-readiness, scoped `HOME` | `native_session` / `unavailable` / `not_run` |
| Headless turn (pinned CLI) | `succeeded` |
| Resume turn on the same session | `succeeded`, same session id |
| Distinct Cursor session ids across both turns | `1` |
| Cancellation | run terminated, launcher exit `143` |
| New Cursor processes observed while active | `2` |
| Those observed processes after cancellation | `1` (vendor-owned detached worker, re-parented to init) |
| Temporary workspace and scoped home | removed |

The redacted machine-readable observation is
[`0017-q018-redacted-trace.json`](0017-q018-redacted-trace.json).

## Findings that shaped the implementation

1. **Cursor credential profiles are API-key-only** (Claudexor INV-135), so the subscription route
   must forward no credential-profile id. Pinned by a test asserting the thread and turn bodies
   carry none.
2. **A successful run can carry no final text.** Cursor returned `subtype: "success"` with an empty
   `result` and no assistant frame; the summary fallback now tests trimmed length so a blank or
   whitespace-only final cannot violate `ExecutionResultV3.summary`'s `minLength: 1`.
3. **The Cursor CLI auto-updates**, so `PATH` no longer serves the approved pin. Every decisive
   observation above was re-captured by invoking the pinned build's absolute path, which does not
   trigger an update.
4. **Scoped-HOME isolation hides the session**, because it is keychain-backed and read through the
   daemon's own `HOME`. Production runs under the real `HOME`, which is what was proven.
5. **A detached `worker-server` process survives cancellation** by design and must be excluded from
   or explicitly reaped by any process-cleanup canary.

## Committed-artifact change

`evidence/0014-q015-capability-matrix.json` records Cursor's `resume` and `cancellation` as
`supported` instead of `unknown`. That file is a drift guard over what the capability catalogue
actually emits, and this issue changed the pinned compatibility attestation those fields derive
from, so leaving it untouched would have made it stale.

## Delivery evidence still pending

The GitHub PR, required-check result, and merge confirmation must be appended after the branch is
published as a non-draft PR with `Closes #19`. They cannot exist before that publication step.
