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

## Review Fix Round 1

### RED Evidence

- An adaptive `loop_checkpoint` with `state: completed`, evidence-backed criteria, and `reason: " "` completed successfully; the service normalized the reason to `null` but only rejected `undefined`.
- Three verified-fact entries containing fifty identical evidence URLs each were accepted because the implementation enforced the limit after deduplication instead of on all stored entries.
- A structurally valid stored checkpoint with padded duplicate strings was returned unnormalized, and a stored inference with `confidence: "certain"` plus an unexpected field was accepted instead of returning `SessionLoop.CheckpointDiagnostic`.
- The deterministic concurrent checkpoint/pause regression failed after temporarily removing the keyed lock: the pause write read the old checkpoint and overwrote the concurrent observation update.

### GREEN Evidence

- Adaptive completion now rejects `undefined`, `null`, empty, and whitespace-only reasons in the service; `loop_checkpoint` returns a tool failure and `loop_wakeup` rejects the blank schema input before execution.
- Evidence limits count every persisted evidence entry before normalization, while normal persisted values remain deduplicated.
- Stored JSON requires the exact checkpoint and nested record shapes, confidence literals, and no extra fields. Successful decodes return canonical normalized values; malformed or semantically invalid storage is omitted with the typed diagnostic.
- `SessionLoop` now uses the repository's `KeyedMutex` pattern for one critical read/merge/write section per loop ID. The regression preserves the checkpoint observation while the concurrent pause retains its state, cleared next run, and reason.
- A true file-backed SQLite/database/service restart test reopens a new `SessionLoop` layer and reads the persisted checkpoint.

## Live-Gate Fix Round 2

### Live Failure Evidence

- A real `opencode run` with Qwen advertised no `loop_*` schemas. Its trace repeatedly selected `capability_search`, because the legacy `SessionTools.resolve` bridge materialized only capability-management definitions and active capability runtime definitions.

### RED Evidence

- The new actual-boundary regression, `bun test test/session/prompt.test.ts -t "session tools bridge always-on Core loop tools"`, initially resolved only the injected legacy `loop_create` collision; `loop_checkpoint`, `loop_delete`, `loop_list`, `loop_update`, and `loop_wakeup` were missing.
- After admitting the six Core definitions, the same real callback test failed with `Unable to create loop`. Diagnostic tracing identified `PermissionV2.BlockedError`: loop tools used Core's default deny policy instead of the per-call legacy permission bridge.

### GREEN Evidence

- `SessionTools.resolve` now bridges exactly the six names exported by `LoopTool.names`, alongside the existing capability rules. Other Core legacy-equivalent tools remain filtered; a collision regression proves bridged `loop_create` supersedes legacy, while injected `bash` remains legacy.
- All mutating loop tools now use `(context.permission ?? permission)`, matching capability tools. Bridged calls therefore make one canonical legacy permission request with `permission: "loop"`, `patterns: ["new"]`, and `always: ["*"]`; a `once` response settles without a second request.
- The boundary regression invokes the bridged callbacks against a persisted session: create, structured checkpoint output, a fresh resolved list, cross-session checkpoint rejection, one-shot permission approval, and delete. It also verifies all six schemas are advertised.

### Verification

```text
packages/opencode:
bun test test/session/prompt.test.ts --timeout 30000 -t "session tools bridge (always-on Core loop tools|capability packs)"
2 pass, 0 fail

bun test test/command-loop.test.ts --timeout 30000
1 pass, 0 fail

packages/core:
bun test test/session-loop.test.ts test/tool-loop.test.ts test/database-migration.test.ts test/location-layer.test.ts --timeout 30000
43 pass, 0 fail

bun typecheck
exit 0

bun script/migration.ts --check
No schema changes, nothing to migrate

packages/opencode:
bun typecheck
exit 0

bun run lint -- [touched TypeScript files]
0 errors; 18 pre-existing warnings in the legacy test files

git diff --check
exit 0
```
