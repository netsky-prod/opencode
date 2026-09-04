# Task 7 Report: Durable Loop Checkpoints

## Outcome

Added nullable durable `checkpoint_json` storage to `session_loop` with a generated migration. `SessionLoop` now persists a bounded checkpoint with normalized strings, up to 50 items per array, 100 unique evidence URLs, and a 128 KiB encoded limit. Corrupt stored JSON is omitted from `Info.checkpoint` and surfaced as the typed `SessionLoop.CheckpointDiagnostic` instead of stopping other loop work.

`loop_create` accepts an optional initial checkpoint, `loop_update` accepts a checkpoint patch, and the new `loop_checkpoint` tool applies a focused partial patch. `loop_list` renders a bounded checkpoint summary. Adaptive completion now requires an explicit reason, a final checkpoint update, and evidence-backed verified facts for every acceptance criterion; fixed loops retain optional checkpoint behavior.

## TDD Record

### RED

- `bun test test/session-loop.test.ts` failed with `TypeError: loops.checkpoint is not a function` after checkpoint persistence and validation behavior tests were added.
- `bun test test/tool-loop.test.ts` failed with `Unknown tool: loop_checkpoint` after the focused partial-merge tool test was added.
- The corrupt-storage regression was mutation-checked by temporarily removing checkpoint decoding; `bun test test/session-loop.test.ts -t "typed diagnostic"` failed because `checkpointDiagnostic` was undefined.

### GREEN

- The checkpoint persistence, validation, completion, partial-merge, and corrupt-storage diagnostics all pass in the focused suite.
- `bun script/migration.ts --name loop_checkpoint` generated `20260904125926_loop_checkpoint`; `bun script/migration.ts --check` confirms the schema and registry are current.

## Verification

From `packages/core`:

```text
bun test test/session-loop.test.ts test/tool-loop.test.ts test/database-migration.test.ts && bun typecheck
34 pass, 0 fail
tsgo --noEmit: exit 0

bun script/migration.ts --check
No schema changes, nothing to migrate

git diff --check
exit 0
```

## Concerns

- Scheduler prompt rendering and compacted-session context injection are deliberately deferred to Task 8. This task exposes checkpoint data and a typed corrupt-storage diagnostic while leaving wake rendering unchanged.
