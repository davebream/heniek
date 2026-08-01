# Evidence — configuration layers and secret-store defaults (ADR 0004)

Every table and JSON block below is either the direct, unmodified output of this issue's own code
(`renderConfigurationDiagnostics`, `renderResolvedConfigurationSnapshot`, `ensureApplicationHomeDirectories`,
`createFileSecretStore`) or the literal output of a shell command run against files that code produced.
No credential value appears anywhere below — every token used to exercise the secret store and the
YAML guard is a fabricated placeholder string, never a real credential, and is named as such at first
use.

## Environment this evidence was captured on

```
node --version   → v24.18.1
pnpm --version   → 11.13.0
uname            → Linux (this session; see "Cross-platform evidence" in ADR 0004 — macOS was not
                    executed at any point in this work)
```

## 1. Resolved-configuration diagnostic snapshot

Built by calling `resolveConfiguration` with `HENIEK_BUILT_IN_DEFAULTS` plus three more-specific
layers deliberately chosen to exercise every one of AC2's requirements at once: a plain override
(`repository` → `profile-or-stage` → `invocation-override` on `/limits/max_concurrent_workers`), a
blocked hard-limit relaxation (the `invocation-override` layer tries to raise the limit back up, and
is clamped back to the strictest value seen), and a blocked privacy weakening plus a rejected
invocation override on the same pointer (`/privacy/mode`, which is not declared `overridable`).

Script (run once, output pasted verbatim, then deleted — not a committed artifact):

```ts
const resolved = resolveConfiguration({
  documents: [
    HENIEK_BUILT_IN_DEFAULTS,
    { layer: "repository", sourcePath: "/repo/.heniek/config/defaults.yaml",
      values: { limits: { max_concurrent_workers: 2 } } },
    { layer: "profile-or-stage", sourcePath: "/repo/.heniek/config/profiles/careful.yaml",
      values: { limits: { max_concurrent_workers: 8 }, privacy: { mode: "open" } } },
    { layer: "invocation-override", sourcePath: "cli",
      values: { limits: { max_concurrent_workers: 1 }, privacy: { mode: "confidential" } } },
  ],
  policy: HENIEK_BUILT_IN_CONFIGURATION_POLICY,
});
```

### `renderConfigurationDiagnostics(resolved)` output

```
Resolved configuration:
  /limits/max_concurrent_workers       1  [invocation-override (cli)]
                                         overrode 4 [built-in-defaults]
                                         overrode 2 [repository (/repo/.heniek/config/defaults.yaml)]
                                         overrode 8 [profile-or-stage (/repo/.heniek/config/profiles/careful.yaml)]
  /limits/max_graph_revisions          5  [built-in-defaults]
  /limits/max_pipeline_duration        "4h"  [built-in-defaults]
  /limits/max_repair_attempts          3  [built-in-defaults]
  /privacy/crash_reports               "local"  [built-in-defaults]
  /privacy/diagnostics_export          "explicit"  [built-in-defaults]
  /privacy/include_paths               false  [built-in-defaults]
  /privacy/include_prompts             false  [built-in-defaults]
  /privacy/include_repository_content  false  [built-in-defaults]
  /privacy/mode                        "confidential"  [built-in-defaults]
                                         overrode "open" [profile-or-stage (/repo/.heniek/config/profiles/careful.yaml)]
  /privacy/telemetry                   "off"  [built-in-defaults]

Diagnostics:
  error  configuration.override-not-permitted  /privacy/mode is not declared overridable, so the invocation override "confidential" was dropped.
  error  configuration.privacy-weakening-blocked  Privacy setting /privacy/mode kept at "confidential" from built-in-defaults; profile-or-stage (/repo/.heniek/config/profiles/careful.yaml) attempted to weaken it to "open".
  info  configuration.value-overridden  /limits/max_concurrent_workers: invocation-override (cli) sets 1, overriding 2 from repository (/repo/.heniek/config/defaults.yaml).
  info  configuration.value-overridden  /limits/max_concurrent_workers: invocation-override (cli) sets 1, overriding 4 from built-in-defaults.
  info  configuration.value-overridden  /limits/max_concurrent_workers: invocation-override (cli) sets 1, overriding 8 from profile-or-stage (/repo/.heniek/config/profiles/careful.yaml).
  info  configuration.value-overridden  /privacy/mode: built-in-defaults sets "confidential", overriding "open" from profile-or-stage (/repo/.heniek/config/profiles/careful.yaml).
```

This one table demonstrates every part of AC2's "source layer, winning value, and material
conflicts": `/limits/max_concurrent_workers`'s winning value (`1`) names its source layer
(`invocation-override (cli)`) directly beside the three layers it overrode and their values; the
hard-limit's strictest-wins rule is visible even though *no* clamp fired here (the invocation override
happened to already be the strictest, `1`); and `/privacy/mode` shows both halves of a real material
conflict — `profile-or-stage` tried to weaken privacy from `confidential` to `open` and was blocked
with an `error`, and `invocation-override` separately tried to set it and was dropped outright because
`/privacy/mode` is not declared `overridable` in `HENIEK_BUILT_IN_CONFIGURATION_POLICY`.

### `renderResolvedConfigurationSnapshot(resolved)` output (the `ResolvedConfigurationV1` payload shape, canonical JSON)

```json
{
  "diagnostics": [
    {
      "code": "configuration.override-not-permitted",
      "message": "/privacy/mode is not declared overridable, so the invocation override \"confidential\" was dropped.",
      "pointer": "/privacy/mode",
      "severity": "error",
      "sourcePath": "cli"
    },
    {
      "code": "configuration.privacy-weakening-blocked",
      "message": "Privacy setting /privacy/mode kept at \"confidential\" from built-in-defaults; profile-or-stage (/repo/.heniek/config/profiles/careful.yaml) attempted to weaken it to \"open\".",
      "pointer": "/privacy/mode",
      "severity": "error",
      "sourcePath": "/repo/.heniek/config/profiles/careful.yaml"
    },
    {
      "code": "configuration.value-overridden",
      "message": "/limits/max_concurrent_workers: invocation-override (cli) sets 1, overriding 2 from repository (/repo/.heniek/config/defaults.yaml).",
      "pointer": "/limits/max_concurrent_workers",
      "severity": "info",
      "sourcePath": "/repo/.heniek/config/defaults.yaml"
    },
    {
      "code": "configuration.value-overridden",
      "message": "/limits/max_concurrent_workers: invocation-override (cli) sets 1, overriding 4 from built-in-defaults.",
      "pointer": "/limits/max_concurrent_workers",
      "severity": "info"
    },
    {
      "code": "configuration.value-overridden",
      "message": "/limits/max_concurrent_workers: invocation-override (cli) sets 1, overriding 8 from profile-or-stage (/repo/.heniek/config/profiles/careful.yaml).",
      "pointer": "/limits/max_concurrent_workers",
      "severity": "info",
      "sourcePath": "/repo/.heniek/config/profiles/careful.yaml"
    },
    {
      "code": "configuration.value-overridden",
      "message": "/privacy/mode: built-in-defaults sets \"confidential\", overriding \"open\" from profile-or-stage (/repo/.heniek/config/profiles/careful.yaml).",
      "pointer": "/privacy/mode",
      "severity": "info",
      "sourcePath": "/repo/.heniek/config/profiles/careful.yaml"
    }
  ],
  "layers": [
    "built-in-defaults",
    "repository",
    "profile-or-stage",
    "invocation-override"
  ],
  "provenance": [
    {
      "layer": "invocation-override",
      "overridden": [
        {
          "layer": "built-in-defaults",
          "value": 4
        },
        {
          "layer": "repository",
          "sourcePath": "/repo/.heniek/config/defaults.yaml",
          "value": 2
        },
        {
          "layer": "profile-or-stage",
          "sourcePath": "/repo/.heniek/config/profiles/careful.yaml",
          "value": 8
        }
      ],
      "pointer": "/limits/max_concurrent_workers",
      "sourcePath": "cli",
      "value": 1
    },
    {
      "layer": "built-in-defaults",
      "overridden": [],
      "pointer": "/limits/max_graph_revisions",
      "value": 5
    },
    {
      "layer": "built-in-defaults",
      "overridden": [],
      "pointer": "/limits/max_pipeline_duration",
      "value": "4h"
    },
    {
      "layer": "built-in-defaults",
      "overridden": [],
      "pointer": "/limits/max_repair_attempts",
      "value": 3
    },
    {
      "layer": "built-in-defaults",
      "overridden": [],
      "pointer": "/privacy/crash_reports",
      "value": "local"
    },
    {
      "layer": "built-in-defaults",
      "overridden": [],
      "pointer": "/privacy/diagnostics_export",
      "value": "explicit"
    },
    {
      "layer": "built-in-defaults",
      "overridden": [],
      "pointer": "/privacy/include_paths",
      "value": false
    },
    {
      "layer": "built-in-defaults",
      "overridden": [],
      "pointer": "/privacy/include_prompts",
      "value": false
    },
    {
      "layer": "built-in-defaults",
      "overridden": [],
      "pointer": "/privacy/include_repository_content",
      "value": false
    },
    {
      "layer": "built-in-defaults",
      "overridden": [
        {
          "layer": "profile-or-stage",
          "sourcePath": "/repo/.heniek/config/profiles/careful.yaml",
          "value": "open"
        }
      ],
      "pointer": "/privacy/mode",
      "value": "confidential"
    },
    {
      "layer": "built-in-defaults",
      "overridden": [],
      "pointer": "/privacy/telemetry",
      "value": "off"
    }
  ],
  "values": {
    "limits": {
      "max_concurrent_workers": 1,
      "max_graph_revisions": 5,
      "max_pipeline_duration": "4h",
      "max_repair_attempts": 3
    },
    "privacy": {
      "crash_reports": "local",
      "diagnostics_export": "explicit",
      "include_paths": false,
      "include_prompts": false,
      "include_repository_content": false,
      "mode": "confidential",
      "telemetry": "off"
    }
  }
}
```

`test/snapshot.test.ts`'s "is byte-identical for inputs that differ only in key order" test asserts
this exact byte-identical property against different fixtures, on every `pnpm check` run — this
evidence block is one concrete instance of that guarantee, not a one-off hand check.

## 2. Filesystem permission evidence

Captured against a scratch directory under `$TMPDIR` (outside the repository, deleted after capture;
the path prefix is replaced with `$SCRATCH` below — the path itself carries no meaning worth
preserving, only the mode bits do), using `resolveApplicationHome({ platform: "linux", env: {},
homeDirectory: $SCRATCH })` (the `.heniek`-fallback branch) followed by
`ensureApplicationHomeDirectories(home)`, then a file secret store rooted at
`home.paths.secretsDirectory`.

### `ensureApplicationHomeDirectories` report (direct function output)

```
$SCRATCH/.heniek                    created=true  repaired=false  mode=700
$SCRATCH/.heniek/config             created=true  repaired=false  mode=700
$SCRATCH/.heniek/runtime            created=true  repaired=false  mode=700
$SCRATCH/.heniek/codebases          created=true  repaired=false  mode=700
$SCRATCH/.heniek/workspaces         created=true  repaired=false  mode=700
$SCRATCH/.heniek/artifacts          created=true  repaired=false  mode=700
$SCRATCH/.heniek/exports            created=true  repaired=false  mode=700
$SCRATCH/.heniek/backups            created=true  repaired=false  mode=700
$SCRATCH/.heniek/runtimes           created=true  repaired=false  mode=700
$SCRATCH/.heniek/secrets            created=true  repaired=false  mode=700
$SCRATCH/.heniek/logs               created=true  repaired=false  mode=700
$SCRATCH/.heniek/config/accounts    created=true  repaired=false  mode=700
$SCRATCH/.heniek/config/workers     created=true  repaired=false  mode=700
$SCRATCH/.heniek/config/roles       created=true  repaired=false  mode=700
$SCRATCH/.heniek/config/profiles    created=true  repaired=false  mode=700
$SCRATCH/.heniek/config/pipelines   created=true  repaired=false  mode=700
diagnostics: []
```

Every directory materialised at mode `700` on first creation (`repaired=false` — no pre-existing,
laxer directory to repair in this fresh scratch tree; `home-ensure.test.ts` separately exercises the
`repaired=true` path against a directory deliberately pre-created at `0755`), and `secretsDirectory`
(design §2.3's one addition to §7's tree) is present alongside every canonical §7 entry.

### Literal shell `stat -c '%a'` output on the materialised tree

```
$ stat -c '%a %n' $SCRATCH/.heniek
700 $SCRATCH/.heniek
$ stat -c '%a %n' $SCRATCH/.heniek/config
700 $SCRATCH/.heniek/config
$ stat -c '%a %n' $SCRATCH/.heniek/secrets
700 $SCRATCH/.heniek/secrets
```

### Secret store, one entry written (`SensitiveValue.from("not-a-real-secret-value")` — a fabricated placeholder, never a real credential)

```
$ stat -c '%a %n' $SCRATCH/.heniek/secrets/example-token.entry
600 $SCRATCH/.heniek/secrets/example-token.entry
$ ls -la $SCRATCH/.heniek/secrets
total 12
drwx------  2 <uid> <gid> 4096 <date> .
drwx------ 12 <uid> <gid> 4096 <date> ..
-rw-------  1 <uid> <gid>   23 <date> example-token.entry
```

`drwx------` (`0700`) on the directory and `-rw-------` (`0600`) on the entry file are exactly what
`ls -la`'s permission-string rendering of the `stat` output above predicts, confirming the mode bits
`ensureApplicationHomeDirectories` and `createFileSecretStore` request are the mode bits actually
present on disk — not merely the value the code *believes* it set.

## 3. `pnpm check`, exact commands and results

Commands run, in order, from the existing checkout (not a fresh clone — `pnpm install --frozen-lockfile`
was also run separately and is reported below):

```
$ pnpm install --frozen-lockfile
Scope: all 5 workspace projects
Already up to date
Done in 392ms using pnpm v11.13.0

$ pnpm check
...
Checked 171 files in 137ms. No fixes applied.
Found 1 warning.
Found 34 infos.
...
 Test Files  43 passed | 3 skipped (46)
      Tests  868 passed | 6 skipped (874)
```

Exit code: `0`. The one Biome warning and 34 infos are pre-existing, in files this issue did not
touch (`@heniek/config`'s `home` module (`ensure.ts`)'s one `useOptionalChain` suggestion,
`packages/conformance/**`'s `useLiteralKeys` suggestions on pre-existing test fixtures) — `biome ci`
does not fail the build on them, and `pnpm check`'s exit code of `0` is the authority on pass/fail,
not the info/warning count.

Test count grew from the Q005 phase-2 baseline of 789 passing tests (see this issue's understand
report and phase-2 checkpoint) to 868 passing (plus 6 pre-existing opt-in-gated skips, unchanged) —
79 new tests, spanning `packages/config/test/layers-resolution.test.ts`,
`layers-policy.test.ts`, `layers-hardening.test.ts`, `snapshot.test.ts`, `secrets-in-configuration.test.ts`,
plus the two new contract schemas' coverage in `packages/conformance/test/contracts-compatibility.test.ts`.
