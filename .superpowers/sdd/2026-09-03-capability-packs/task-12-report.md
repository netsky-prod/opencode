# Task 12 — Distribution and release verification

## Status

Implementation is under final verification; the milestone is **not complete**. The first native acceptance scenario was invalidated by a real execution-driver defect. Its process was stopped and all SQLite/artifacts preserved. A fresh native run, final integration, push and installed-binary verification are still required.

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
- Core, OpenCode, schema, SDK and client typechecks passed. Migration \`--check\` passed with no SQL schema change. Scoped lint reported 40 warnings and zero errors across changed files (including existing warnings in those files); this is not a zero-warning claim. \`git diff --check\` passed.

The latest 260-file isolated OpenCode sweep was **not green**: CLI subprocesses exceeded their startup/run budgets under concurrent heavy tests, event-manifest count was stale, and one MCP prompt test hung in teardown after its assertions. CLI file subsequently passed all **13 tests unchanged**, with no extended timeouts, when not competing with the Core suite. Event inventories are corrected. The MCP test interrupted only its waiter, leaving the service-owned runner's hanging SSE open while the fixture Node HTTP server attempted graceful shutdown. An explicit prompt-cancel body finalizer closes it before server teardown; the original 15-second limit remains, and the test passes in under one second. Independent review confirmed this lifecycle explanation. Earlier historical green sweeps are not substituted for the pending final sweep.

## Live evidence

The historical five-case run at `9c960b1` reported 20% baseline versus 80% candidate completion; its recovery case contained a confirmed evaluator false negative. The report is preserved unchanged.

A fresh corrected proof/recovery A/B at clean `d15cd7f` passed: baseline **0/2**, candidate **2/2**, each candidate **3/3 externally verified criteria**, exactly four additional default schemas, matching effective prompts. Sanitized metrics are in `live/final/result.json`.

The first native Follow-up Desk run is rejected because its histories were split. Earlier functional observations are not final acceptance. Raw logs/DB and the overwritten report copy are retained locally. A fresh runner targets a new `live/final/native-r2/` directory, refuses to overwrite an existing identity file, uses isolated configs/DB, the current research credential through an environment reference, and no quality deadline.

## Local prerequisites and preservation

Standalone official Node v24.20.0 (archive SHA-256 verified), npm/npx and shell references for research are installed. The obsolete legacy research authorization was replaced with the existing RunPod environment key reference. Original global MCP entries, original Superpowers and custom skills remain intact; no implicit opt-in migration was performed. Config/shell backups and the previously installed native binary backup are retained. The new native binary is not installed yet.

## Remaining release gates

1. Finish the isolated OpenCode sweep with the corrected test cleanup and inventories.
2. Review and commit the runtime correction, then build a native binary from that revision.
3. Run Qwen in a clean native session; independently verify UI/mobile persistence, source claims, real browser screenshot, one conversation, durable completed checkpoint and pack release.
4. Record sanitized evidence, integrate/push the fork, install the verified binary and check an ordinary user shell.
5. Only then mark the current user goal complete. Peer swarm is the next milestone recorded in `docs/swarm-next.md`, not part of this acceptance.

## Acceptance mapping

| Requirement                                         | Evidence / remaining gate                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Four added default schemas                          | Corrected Task 11 actual provider snapshots and fresh-registry e2e passed                                             |
| Next-turn browser activation                        | Prompt bridge tests and earlier native activation; fresh native gate pending                                          |
| Session isolation                                   | Core state/materialization and host runtime tests passed                                                              |
| Disable removes tools/releases unused runtime       | Ownership/ref-count/stale-call tests and Task 10 real event trace passed                                              |
| Browser/research end-to-end                         | Earlier slice gates and Task 11 external verifier passed; fresh native acceptance pending                             |
| Durable epistemic checkpoint, restart/wake/complete | Core loop tests, host restart/compaction tests and Task 8 live result; native final pending                           |
| Actionable platform status for every pack           | Task 9 per-pack runs; npx and unsupported-platform smoke tests passed                                                 |
| Permissions and credentials                         | Canonical permission/resource extraction, denied side-effect and redaction tests; final outgoing-history scan pending |
| Better completion with compact default surface      | Small corrected proof/recovery A/B passed; benchmark limitation retained                                              |
| Documented installable fork                         | Embedded payload compile/execute and earlier native build passed; final integration/install pending                   |
