# Task 9 Report: Operational Capability Packs

## Outcome

Task 9 ships five built-in operational packs:

- `mobile/{ios,android}`
- `security/{static,dynamic}`
- `documents/default`
- `github/default`
- `deploy/{core,runpod,cloudflare}`

Each manifest has the exact required probes, a routing skill, profile-local optional dependency health, and no embedded credentials. Security and deploy guidance keeps operations behind the existing canonical `bash` permission action. Large command output continues through the existing session `ToolOutputStore`.

## Architecture

The manifest schema now supports optional `platforms` on profiles and optional `profiles` on dependencies. Both fields are backward compatible: omitted profile platforms inherit the pack platforms, and omitted dependency profiles apply to every profile. Validation rejects a profile platform outside its pack and a dependency that names an unknown profile.

`capability_status` now returns a provider-safe `profileStatus` record. Unsupported profiles are reported without running their probes. Dependencies are probed only for compatible profiles, so a missing optional executable degrades only profiles that declare it. On Linux, `mobile/ios` is deterministic `unsupported` while `mobile/android` remains independently usable or degraded.

The live gate exposed that the configured Qwen provider serializes optional arrays as empty arrays. The earlier fallback assumed every pack had a literal `default` profile, which is false for three Task 9 packs. `capability_enable` therefore adds a backward-compatible singular `profile` field. Resolution is deterministic: a non-empty `profiles` array, a matching singular `profile`, a literal `default`, or the sole available profile. Conflicting aliases and ambiguous multi-profile omission fail with actionable errors and no probe or persistence side effect.

## TDD Evidence

Initial RED from `packages/core`:

- Manifest/catalog tests: 7 passed, 3 failed because profile platforms, profile-scoped dependencies, permission hints, and the five built-ins did not exist.
- Status tests: 0 passed, 2 failed because actual `capability_status` had no `profileStatus` and no profile-local platform/probe isolation.
- Provider compatibility regression: 0 passed, 1 failed because the model-facing `capability_enable` schema lacked singular `profile`.
- Review regressions: 0 passed, 2 failed because an inactive required failure was flattened to `installed` and active remediation included an unselected profile. The minimal aggregation fix then passed both cases.

Final focused GREEN:

- Core capability/manifest/catalog/state/runtime/plugin suite: 67 passed, 0 failed.
- OpenCode capability integration suite: 14 passed, 0 failed.
- OpenCode provider-bridge regression: 1 passed, 0 failed.
- Core and OpenCode typechecks: passed.

A broader Core run recorded 1,205 passing tests. Fifteen cross-spawn cases failed only because the shell `PATH` did not expose Node; the exact file then passed 24 of 24 with the bundled Node runtime exposed. One pre-existing node-build composition test remains red because `CapabilityRuntime` is intentionally unbound at the Core layer; Task 9 does not change that graph.

Scoped lint has zero errors, formatting is clean, and the generated database schema check reports no changes. Repository-wide lint still reports one pre-existing octal-escape error in an unchanged session UI file; a base-to-worktree diff confirms Task 9 did not touch it.

The OpenCode smoke suite uses real disposable executables on `PATH`. It verifies exact probe arguments, Linux iOS unsupported status without iOS probe execution, Android-only degradation, embedded skill loading, oversized output retention, and permission denial before security/deploy execution.

## Live Qwen Acceptance

`/usr/bin/screen` was used as the tmux-equivalent because tmux is unavailable. Every final gate ran in its own named screen session with global research MCP substitutes disabled. The concise redacted result is `live/slice-3/task9-result.json`; raw traces and fixtures remain local and ignored.

- Mobile selected only `mobile/ios`, loaded its skill, observed the actual Xcode installation and simulator inventory, reported missing Flutter as actionable optional degradation, wrote and reread its report, and disabled the pack.
- Security selected only `security/static`, invoked the deterministic Semgrep-compatible fixture through `bash`, detected `SECGATE001` at the seeded source line, reproduced it from source, preserved scanner JSON and a remediation report, and disabled the pack.
- Documents selected only `documents/default`, ran the deterministic extractor, produced and independently checked a 65,822-byte retained tool-output artifact, matched four facts and their source lines, and disabled the pack.
- GitHub selected only `github/default`, used read-only Git and deterministic `gh` fixture commands, matched repository and pull-request metadata, and disabled the pack. Independent checks proved the fixture HEAD and clean working tree were unchanged and no mutation command ran.
- Deploy selected only `deploy/core`. Because the Docker daemon was already available, it built with `--pull=false` from an already-present base image, reached container health, verified the exact response externally over loopback, recorded evidence, removed the disposable Compose service, and disabled the pack. No desktop application was launched.

Two deploy fixture diagnostics were stopped and cleaned before acceptance: the first revealed an unavailable Alpine HTTP executable, and the second revealed an unavailable healthcheck executable in the replacement base. The final fixture uses Python for both serving and health verification, performs no package installation or pull, and has a preflight that executes the actual health assertion. An injected nonzero failure after resource creation verified the harness cleanup trap.

## Cleanup and Hygiene

Independent post-run checks found zero owned screen sessions, OpenCode processes, containers, images, networks, or listeners. The prior browser-fixture port is also clear. The disposable Git repository is unchanged. A model-created report that initially landed outside the ignored evidence tree was moved into the ignored tree and the stray directory was removed.

Raw transcripts contain runtime-local paths and identifiers and remain ignored. The tracked result and this report contain no personal paths, session IDs, hostnames, timestamps, credentials, or environment values. Only environment placeholders remain in reusable production configuration.

## Changed Production Areas

- Capability manifest schema and validation.
- Capability status/probe/profile selection behavior.
- Built-in pack registration.
- Five manifest and skill directories.
- Core manifest/plugin/tool tests.
- OpenCode deterministic pack smoke tests and provider-bridge regression.

## Remaining Constraint

Operational CLIs are intentionally optional. A pack can activate in `degraded` state when a selected profile is missing optional tools; its returned remediation identifies each missing executable. Provider-side cloud authentication and real remote mutations were deliberately not exercised.
