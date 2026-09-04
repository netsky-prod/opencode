# Task 12 — Distribution and release verification

## Status

Implementation, final regression verification, fresh native acceptance, local installation, and ordinary-shell verification are complete. Source integration/push is the remaining release action. The first native acceptance scenario was invalidated by a real execution-driver defect; it remains preserved, not counted as acceptance. The corrected runtime is committed at `41d5490`.

## Distribution work

- `d15cd7f`: authoring/install/migration guide, compiled native payload probe, four-management-schema assertion, OAuth callback required-body contract and actual SDK generator regression.
- `4817953`: complete manifest/skill payload comparison, sanitized final evidence, permissions metadata documentation.
- `80d17df` and `2eecdfd`: required browser npx dependency/probe fixture, exact adaptive-completion criterion guidance, local-channel native build recipe.
- Assets are static Bun imports embedded in the native binary. External runtimes remain separate documented dependencies.
- Task 11 evaluator fixes include actual Chromium/PDF/binary evidence where applicable, exact effective-prompt hashes, structured failure accounting and same-profile recovery. Fixture scores are not general model-quality claims.

## Native-found defect and correction

The old scheduler delivered a loop from the legacy foreground conversation through Core execution. The same session acquired independent `message/part` and `session_message` histories; the wake lacked InstanceRef and overwrote a browser-verified report.

The correction keeps canonical durable input admission while selecting the owning execution driver. Legacy loop messages are projected idempotently into the existing conversation; a serialized runner wake follows foreground work without replacing its HTTP result. A durable acknowledgement marks host projection without creating a second Core transcript. Native Core sessions retain Core execution.

Recovery is bounded to 32 leased loop-owned admissions per tick and observes failure backoff. Claimed retries survive admission-to-projection crash windows without waiting for the next cadence. An acknowledgement does not imply provider completion: no automatic post-acknowledgement replay of provider work or side effects was added. Old split histories require inspection and explicit resume; they are not silently merged. Background Core MCP calls receive bound InstanceStore/WorkspaceRef context.

Regressions include held real HTTP/provider requests, sequential coalesced wakes, foreground result preservation, ordinary-queue isolation, partial projection/restart boundaries, exact acknowledgement and part identity, retry/backoff/cadence races, and a background MCP adapter with InstanceRef absent.

## Verification ledger

- Latest Core full suite: **1243 passed, 0 failed; 3573 assertions, 157 files** (`/tmp/capability-release-core-final-r2.log`).
- Core targeted admission/loop/scheduler suite: **56 passed**, including a reproduced RED→GREEN admission-retry crash case and explicit post-ACK/no-provider-replay boundary.
- Legacy HTTP/restart and runner tests: **35 passed** before the additional retry boundary; that additional process-restart case passed separately.
- A direct legacy-inbox retry test reproduced false instead of true before the corresponding fix, then passed all four assertions, including respecting a newer delivery failure.
- Actual public OpenAPI: **19 passed**. SDK generator/history: **2 passed**; generator timeout was raised to 30 seconds after a 14.9-second generator run exceeded its default 5-second limit under parallel load. Output assertions were unchanged.
- Schema full suite: **15 passed** after updating canonical event inventories for the three earlier capability events and the new acknowledgement.
- Core, OpenCode, schema, SDK and client typechecks passed. Migration `--check` passed with no SQL schema change. Scoped lint reported 40 warnings and zero errors across changed files (including existing warnings in those files); this is not a zero-warning claim. `git diff --check` passed.
- Final complete isolated OpenCode sweep: **260 files passed, 0 failed, exit 0**, with no file filtering (`/tmp/capability-release-isolated-final-r2.log`). This is an isolated-process sweep, not a single shared-process `bun test` claim.
- Final prompt suite: **64 passed, 1 existing skip, 0 failed**; final loop HTTP/restart plus manifest tests: **8 passed**. Native build with embedded Web UI, asset probe, and eval dry-run passed.

An earlier 260-file isolated OpenCode sweep was **not green**: CLI subprocesses exceeded their startup/run budgets under concurrent heavy tests, event-manifest count was stale, and one MCP prompt test hung in teardown after its assertions. CLI file subsequently passed all **13 tests unchanged**, with no extended timeouts, when not competing with the Core suite. Event inventories were corrected. The MCP test interrupted only its waiter, leaving the service-owned runner's hanging SSE open while the fixture Node HTTP server attempted graceful shutdown. An explicit prompt-cancel body finalizer closes it before server teardown; the original 15-second limit remains, and the test passes in under one second. Independent review confirmed this lifecycle explanation. The fresh final sweep above passed after these corrections; earlier green runs are not substituted for it.

## Live evidence

The historical five-case run at `9c960b1` reported 20% baseline versus 80% candidate completion; its recovery case contained a confirmed evaluator false negative. The report is preserved unchanged.

A fresh corrected proof/recovery A/B at clean `d15cd7f` passed: baseline **0/2**, candidate **2/2**, each candidate **3/3 externally verified criteria**, exactly four additional default schemas, matching effective prompts. Sanitized metrics are in `live/final/result.json`.

The first native Follow-up Desk run is rejected because its histories were split. Raw logs/DB and the overwritten report copy are retained locally. A fresh runner used a new `live/final/native-r2/` directory, refused to overwrite an existing identity file, used isolated configs/DB and environment-referenced research authorization, and imposed no quality deadline. It ran actual native CLI Qwen sessions under macOS `screen` because tmux was unavailable.

The fresh native acceptance at clean `41d5490` passed: **8/11 baseline, 11/11 candidate** with identical prompt hashes. Both applications passed all six independently exercised functional UI checks. The three additional candidate checks were actual research MCP use, browser tool use, and a real screenshot. Both retained one conversation, a completed checkpoint, zero pending loop inputs and zero activated packs. Candidate took 10m39s versus baseline 7m12s; this is not a speed or general model-quality claim. The baseline scorer was corrected symmetrically from 7 to 8 because valid file evidence was present in verified facts rather than the artifacts array; original strict output is preserved. See [final evidence](./live/final/result.md) for protocol, ordered tool traces, hashes, scorer correction and source-quality limitations.

## Local prerequisites and preservation

Standalone official Node v24.20.0 (archive SHA-256 verified), npm/npx and shell references for research are installed. The obsolete legacy research authorization was replaced with the existing RunPod environment key reference. Original global MCP entries, original Superpowers and custom skills remain intact; no implicit opt-in migration was performed. Config/shell backups and the previously installed native binary backup are retained.

The exact tested native binary is installed: version `0.0.0-local-202609042243`, SHA-256 `79a9310d0c46c5a322834a9083f805f6a2fcf743aac5881f0c1c2b19a74a41a0`. Ordinary interactive zsh resolved the installed binary, Node v24.20.0 and npx 12.0.2, connected both existing `gemini-research` and `context7` MCPs, and discovered the existing 16 skills. Source build/install is documented; no new public binary release is claimed.

## Remaining release gates

Final sanitized-evidence review is clear after disambiguating the published build metadata from private session identifiers. Outgoing-history credential checks passed; all outgoing authors/committers use the requested `netsky_prod <netsky_devel@proton.me>` identity.

1. Fast-forward the clean `dev` checkout and push the verified fork; verify the remote revision.
2. Only then mark the current user goal complete. Peer swarm is the next milestone recorded in `docs/swarm-next.md`, not part of this acceptance.

## Acceptance mapping

| Requirement                                         | Evidence / remaining gate                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Four added default schemas                          | Corrected Task 11 actual provider snapshots and fresh-registry e2e passed                                             |
| Next-turn browser activation                        | Prompt bridge tests and fresh native activation passed                                                                |
| Session isolation                                   | Core state/materialization and host runtime tests passed                                                              |
| Disable removes tools/releases unused runtime       | Ownership/ref-count/stale-call tests and Task 10 real event trace passed                                              |
| Browser/research end-to-end                         | Slice gates, corrected Task 11 verifier and fresh native candidate 11/11 passed                                       |
| Durable epistemic checkpoint, restart/wake/complete | Core loop tests, host restart/compaction tests, Task 8 and final native single-conversation completion passed         |
| Actionable platform status for every pack           | Task 9 per-pack runs; npx and unsupported-platform smoke tests passed                                                 |
| Permissions and credentials                         | Canonical permissions, denied side-effect and redaction tests, final outgoing-history privacy and author checks passed |
| Better completion with compact default surface      | Small corrected proof/recovery A/B passed; benchmark limitation retained                                              |
| Documented installable fork                         | Embedded payload, final native build, exact binary installation and ordinary-shell checks passed; push pending        |
