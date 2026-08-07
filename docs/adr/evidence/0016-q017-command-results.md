# Q017 Codex conformance report

Recorded on 2026-08-07 from the detached, clean checkout of commit
`5d59c2e50463fe88ada31f9bdfefcd76b7255010`.

## Runtime selection and authentication

| Fact | Observed value |
| --- | --- |
| Claudexor protocol | `/v2`, major `3`; compatible handshake |
| Claudexor engine | `3.1.2` |
| Codex CLI | `0.146.0` |
| Model / effort | `gpt-5.6-sol` / `low` |
| Requested auth route | `subscription` + `native_session` |
| Attested auth route | native ChatGPT session: available and passed |
| API-key fallback | unavailable; no OpenAI key fallback |

The observation used the loopback control API's bearer authentication locally.
No token, account material, run identifier, prompt transcript, or control URL
is recorded in this repository.

## Clean-checkout acceptance gate

```text
$ node --version
v24.19.0

$ codex --version
codex-cli 0.146.0

$ pnpm install --frozen-lockfile
Done in 945ms using pnpm v11.13.0

$ pnpm check
Test Files  116 passed | 3 skipped (119)
Tests       1720 passed | 9 skipped (1729)
```

`pnpm check` also completed formatting, backlog integrity, generated-contract,
conformance, and TypeScript checks successfully.

## Opt-in native-session canaries

| Canary | Result |
| --- | --- |
| Headless Codex turn | `succeeded` |
| Resume turn on the same thread | `succeeded` |
| Native Codex sessions on that thread | `1` |
| Structured event kinds observed | lifecycle, harness, budget, output, and session-continuity events |
| Cancellation | `cancelled` |
| New Claudexor descendant processes observed while active | `1` |
| Those observed descendants after cancellation | `0` |
| Temporary canary workspace and thread | trashed |

The redacted machine-readable observation is
[`0016-q017-redacted-trace.json`](0016-q017-redacted-trace.json).

## Delivery evidence still pending

The GitHub PR, required-check result, and merge confirmation must be appended
after the branch is published as a non-draft PR with `Closes #18`. They cannot
exist before that publication step.
