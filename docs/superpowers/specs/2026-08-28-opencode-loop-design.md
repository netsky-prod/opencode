# Durable `/loop` Scheduler for OpenCode

**Date:** 2026-08-28

**Repository:** `netsky-prod/opencode`

**Target branch:** `loop-scheduler` (merge into the fork's `dev` after review)

## Summary

Add a native, durable loop scheduler to the OpenCode fork. A user can ask the current session to continue work on a fixed cadence or let the agent choose the next wake-up time. The schedule survives an OpenCode restart, injects work through the V2 durable prompt inbox, never interrupts a running turn, coalesces missed or busy intervals, and can be managed by the user or the agent through built-in tools.

The feature ships inside the fork's normal `opencode` binary. It does not use keyboard automation, tmux polling, a macOS LaunchAgent, an MCP sidecar, or a second daemon.

## Goals

- Support Claude-style commands:
  - `/loop 10m inspect CI and fix the next failure`
  - `/loop inspect CI and choose when to check again`
  - `/loop 10m` for a default “continue useful work” maintenance prompt
  - bare `/loop` for adaptive maintenance
- Persist loops in the same SQLite database as sessions.
- Execute scheduled prompts only through the V2 session path.
- Queue behind a running turn and keep at most one unconsumed invocation per loop.
- Coalesce elapsed intervals instead of replaying a burst after downtime.
- Allow an adaptive loop to schedule its next wake-up or stop itself.
- Show the loop ID, state, next wake-up, cadence, and reason in ordinary TUI tool output.
- Produce installable macOS and Linux release binaries from `netsky-prod/opencode`.
- Keep an `upstream` remote and make future upstream syncs reviewable.

## Non-goals for the first release

- Running while every OpenCode process is closed.
- Calendar expressions, wall-clock schedules, time zones, or cron syntax.
- A persistent footer/widget or a new scheduling screen.
- A hosted scheduler or cross-machine execution.
- Catching up every interval missed during downtime.
- Replacing already-admitted session input when a loop is deleted.
- Publishing fork packages to npm, Homebrew, Scoop, or Chocolatey.
- Desktop application signing and notarization.

## User experience

### Slash-command grammar

The fork registers a built-in `loop` command whose template interprets:

| Form                        | Meaning                                          |
| --------------------------- | ------------------------------------------------ |
| `/loop <duration> <prompt>` | Fixed recurring loop                             |
| `/loop <prompt>`            | Adaptive loop; the agent selects future wake-ups |
| `/loop <duration>`          | Fixed loop using the maintenance prompt          |
| `/loop`                     | Adaptive loop using the maintenance prompt       |
| `/loop list`                | List loops for the current session               |
| `/loop pause <id>`          | Pause future invocations                         |
| `/loop resume <id>`         | Resume and schedule from now                     |
| `/loop delete <id>`         | Delete future invocations                        |

Reserved management words are `list`, `pause`, `resume`, and `delete`. A prompt beginning with one of them uses `/loop -- <prompt>`.

Accepted duration units are `s`, `m`, `h`, and `d`, with a minimum of 10 seconds and maximum of 7 days. The duration parser rejects mixed or ambiguous values instead of guessing.

The command turn schedules the loop but does not perform the scheduled task itself. A newly created adaptive loop gets its first invocation as soon as the creating turn finishes.

### Maintenance prompt

The built-in maintenance prompt is:

> Continue the current task from where it stopped. Inspect the latest state, make the next useful progress, and verify your work. If the task is genuinely complete or cannot progress without the user, stop this loop and explain why.

### Visible results

Create, update, wake-up, list, and delete tools return concise text suitable for the existing tool-result view. A create result includes:

- stable loop ID;
- fixed or adaptive mode;
- next scheduled time in absolute local time and relative duration;
- prompt summary;
- reason, when supplied;
- the fact that OpenCode must be running.

No TUI-specific state store is added in v1. `/loop list` is the durable source of truth, so the feature works in the TUI, `opencode run`, and attached clients without maintaining parallel UI state.

## Semantics

### Fixed loops

A fixed loop has an interval and a `next_run_at`. When it becomes due, the scheduler admits one queued prompt and advances `next_run_at` to the first cadence boundary strictly after the current time.

If an earlier invocation from the same loop is still pending, no second prompt is admitted. The cadence advances past elapsed boundaries, preserving at most one pending invocation and preventing a backlog.

### Adaptive loops

An adaptive loop is admitted immediately after creation. Its injected prompt includes its loop ID and tells the agent to call `loop_wakeup` before finishing:

- schedule the next run with a delay and reason;
- pause;
- or mark the loop complete.

On every adaptive admission the scheduler installs a 10-minute fallback wake-up. A successful `loop_wakeup` call atomically replaces that fallback. This keeps the loop alive if a model forgets the tool call while still allowing the agent to slow down, speed up, or stop.

### Busy sessions

Every scheduled invocation calls `SessionV2.prompt` with `delivery: "queue"`. The V2 runner promotes queued input only after the active turn reaches an idle boundary. Scheduled work therefore cannot steer or interrupt the current response.

The implementation must not bridge through legacy `SessionPrompt.loop`.

### Restarts and downtime

Loops live in SQLite and have no automatic seven-day expiration. The scheduler exists only inside a running OpenCode server/process:

- closing all OpenCode processes pauses execution without changing loop state;
- startup scans active loops;
- a loop overdue at startup produces at most one invocation;
- fixed cadence advances to the first future boundary;
- adaptive cadence uses its recorded next wake-up or fallback;
- missed occurrences are never replayed individually.

### Pause, completion, and deletion

- **Pause** retains configuration and clears future claims. Resume schedules the next fixed interval from resume time; adaptive resume is due immediately.
- **Complete** retains history and the last reason but no longer schedules.
- **Delete** removes the loop row. Because session prompt admission is durable, an invocation already admitted to `session_input` may still execute once. Tool output must state this when a pending message exists.
- Deleting a session cascades deletion to all of its loops.

## Storage model

Add `SessionLoopTable` to `packages/core/src/session/sql.ts` and generate a TypeScript database migration.

| Column               | Type             | Purpose                                       |
| -------------------- | ---------------- | --------------------------------------------- |
| `id`                 | text primary key | Stable `loop_...` identifier                  |
| `session_id`         | text foreign key | Owning session, cascade on delete             |
| `prompt`             | text             | User-authored task text                       |
| `mode`               | text             | `fixed` or `adaptive`                         |
| `interval_ms`        | integer nullable | Required for fixed, null for adaptive         |
| `state`              | text             | `active`, `paused`, or `completed`            |
| `next_run_at`        | integer nullable | Epoch milliseconds; null when inactive        |
| `last_due_at`        | integer nullable | Last cadence boundary claimed                 |
| `last_admitted_at`   | integer nullable | Last successful prompt admission              |
| `pending_message_id` | text nullable    | Idempotency key for the one outstanding input |
| `reason`             | text nullable    | Human-readable scheduling reason              |
| `last_error`         | text nullable    | Bounded diagnostic string                     |
| `lease_owner`        | text nullable    | Scheduler process UUID                        |
| `lease_expires_at`   | integer nullable | Crash-recovery lease                          |
| timestamps           | integer          | Created and updated                           |

Indexes:

- `(state, next_run_at)` for due scans;
- `(session_id, state)` for management;
- unique nullable `pending_message_id`.

Database-level checks enforce valid mode/interval and state/next-run combinations where supported; service decoding enforces the same invariants for every row.

## Core architecture

### 1. `SessionLoop` global service

Create `packages/core/src/session/loop.ts` as the storage and state-transition boundary. It depends on `Database` and exposes typed operations:

- `create`;
- `list(sessionID)`;
- `get`;
- `update` for prompt, cadence, pause, resume, and completion;
- `delete`;
- `claimDue`;
- `markAdmitted`;
- `recordFailure`;
- `reconcilePending`.

All state changes use compare-and-set predicates in SQLite. Tool handlers and the scheduler never update loop rows directly.

### 2. `SessionLoopScheduler` global service

Create a separate global scheduler node that depends on `SessionLoop`, `SessionV2`, and the database-backed session input view. Splitting storage from execution avoids a dependency cycle:

`SessionV2 -> LocationServiceMap -> built-in loop tools -> SessionLoop`

while the eager scheduler can independently depend on both `SessionV2` and `SessionLoop`.

The scheduler starts one scoped fiber in the server layer and ticks once per second with Effect scheduling primitives. It performs a bounded due scan per tick so thousands of rows cannot monopolize the runtime.

### 3. Built-in tools

Register location-scoped tools through the canonical `Tools.Service` and add their nodes to `BuiltInTools.node`:

- `loop_create`
  - input: prompt, fixed/adaptive schedule, optional reason;
  - output: complete loop summary.
- `loop_list`
  - current session only;
  - output: active, paused, and completed loops.
- `loop_update`
  - update prompt/cadence or pause/resume/complete by ID;
  - rejects IDs owned by another session.
- `loop_delete`
  - delete by ID within the current session.
- `loop_wakeup`
  - intended for adaptive scheduled turns;
  - action is `schedule`, `pause`, or `complete`;
  - `schedule` requires delay and reason.

Mutating tools assert a `loop` permission scoped to the current session. The slash-command template asks for a saved approval so unattended wake-ups do not repeatedly block on the same permission.

### 4. Built-in command

Add `loop` beside `init` and `review` in the default command registry, backed by a versioned template file. The template:

- parses only the documented grammar;
- calls the loop tools rather than emulating a timer;
- does not execute the scheduled task in the command turn;
- reports validation errors directly;
- uses the maintenance prompt when task text is omitted.

## Claim and admission algorithm

Each scheduler tick:

1. Reconcile rows with `pending_message_id`:
   - if the matching `SessionInput` has `promotedSeq`, clear pending state;
   - if admission never occurred and the lease expired, make the same message ID retryable;
   - if it exists but is unpromoted, keep it pending.
2. Select a bounded batch of active rows with `next_run_at <= now`.
3. Atomically claim each row only when its lease is absent or expired.
4. Reuse `pending_message_id` or create one before leaving the transaction.
5. Advance scheduling state:
   - fixed: first cadence boundary after `now`;
   - adaptive: `now + 10 minutes` fallback.
6. Call `SessionV2.prompt` using that message ID, the wrapped prompt, `delivery: "queue"`, and normal wake behavior.
7. On success, record admission and release the lease.
8. On transient failure, retain the same message ID, store a bounded error, release/expire the lease, and retry with capped exponential backoff.

`SessionInput.admit` is already idempotent by message ID, so a crash between admission and bookkeeping cannot duplicate the user message. SQLite leases prevent two OpenCode processes sharing the database from claiming the same occurrence concurrently.

The wrapped scheduled prompt contains the loop ID, mode, original task, and scheduling instructions. It never claims that time elapsed exactly; queue delay is expected.

## Failure behavior

- Missing/deleted session: mark the loop completed with a diagnostic reason.
- Invalid stored row: skip it, log an error with loop ID, and continue the batch.
- Model/provider failure: normal session retry/error behavior applies; the next cadence remains scheduled.
- Database busy: retry on the next scheduler tick.
- Repeated admission failure: capped backoff, maximum five minutes, with no duplicate prompt ID.
- Process crash: expired lease makes the occurrence retryable.
- Clock moves backward: do nothing until `next_run_at` is reached.
- Clock jumps forward: coalesce to one occurrence and advance beyond the new current time.

## API boundary

The first release adds no public HTTP endpoints and therefore requires no generated SDK changes. The slash command and model tools run in the same process as the global loop service. This deliberately keeps the first slice small and preserves behavior for TUI, run, and attach flows.

An HTTP CRUD API can be added later if external dashboards need loop management. At that point it must use the same `SessionLoop` service rather than duplicate scheduling logic.

## Testing

### Core unit tests

- duration parsing boundaries and invalid input;
- fixed next-run calculation, including long downtime;
- adaptive fallback and wake-up replacement;
- create/list/update/delete ownership checks;
- pause, resume, and complete transitions;
- one pending input per loop;
- fixed intervals coalesced while pending;
- deterministic retry with the same message ID;
- expired lease recovery;
- competing scheduler claimers admit once;
- session deletion cascades loops;
- already-admitted input behavior on delete.

Use Effect TestClock for scheduler tests; do not use wall-clock sleeps.

### Session integration tests

- scheduled prompt is admitted with `delivery: "queue"`;
- busy session is not interrupted;
- queued prompt is promoted after the active turn;
- restart with an overdue loop admits once;
- two loops in one session remain independently bounded;
- adaptive scheduled prompt can reschedule or complete itself through tools.

### Command and tool tests

- every slash-command form maps to the correct tool input;
- reserved management words and `--` escape;
- human-readable output includes ID, next run, mode, and reason;
- permission denial leaves storage unchanged;
- cross-session IDs are rejected.

### Release verification

- existing `packages/core` and `packages/opencode` test suites;
- typecheck for changed packages;
- migration generation check;
- native `--single` build and `opencode --version` smoke test;
- installer test against a temporary install directory;
- release workflow artifact-name check for Darwin arm64/x64 and Linux arm64/x64.

## Fork release and installation

### Installer

Keep the executable name and install directory compatible with OpenCode, but change the fork's `install` script to download releases and version metadata from `netsky-prod/opencode`.

Document the install command:

```bash
curl -fsSL https://raw.githubusercontent.com/netsky-prod/opencode/dev/install | bash
```

The installer explicitly says that it replaces any `opencode` currently resolved from `~/.opencode/bin`. `opencode upgrade` must use the same fork installer and `netsky-prod/opencode` latest-release endpoint for curl installations so an upgrade cannot silently replace the fork with upstream.

### Release workflow

Do not reuse the upstream `publish.yml`: it is repository-gated to `anomalyco/opencode`, relies on Blacksmith runners, app credentials, signing secrets, npm publication, and desktop packaging.

Add a fork-specific manual workflow using GitHub-hosted runners and `GITHUB_TOKEN`:

1. accept an explicit semver such as `1.18.25-loop.1`;
2. create tag and draft GitHub release;
3. run the existing Bun CLI build for supported unsigned targets;
4. upload archives with the exact names expected by `install`;
5. smoke-test native artifacts;
6. publish the release only after all required artifacts exist.

The first release supports the CLI binary only. macOS Gatekeeper behavior for unsigned binaries is documented honestly.

## Upstream maintenance

The clone keeps:

- `origin = https://github.com/netsky-prod/opencode.git`
- `upstream = https://github.com/anomalyco/opencode.git`

Upstream updates are manual and reviewable:

```bash
git fetch upstream
git switch dev
git merge --ff-only upstream/dev
git push origin dev
```

If the fork's `dev` contains feature commits, sync through a dedicated branch and merge after tests instead of forcing history. No workflow automatically merges upstream into a release branch.

## Delivery sequence

1. Storage schema, generated migration, and `SessionLoop` state machine with tests.
2. Scheduler claim/admission/recovery behavior with TestClock integration tests.
3. Built-in tools and permissions.
4. Built-in `/loop` command template and command tests.
5. Fork installer, upgrade source, and fork release workflow.
6. Full verification, native build smoke test, and first prerelease.

## Acceptance criteria

- A fixed `/loop 10m ...` survives process restart and resumes without replay bursts.
- A busy turn is never interrupted by scheduled work.
- A loop has no more than one unpromoted scheduled input.
- Two concurrent scheduler processes do not duplicate an occurrence.
- An adaptive loop can select its next delay and stop itself.
- `/loop list` reports durable state accurately after restart.
- Pausing prevents new admission; resuming schedules predictably.
- The fork installs on a clean supported Mac or Linux host from its GitHub release.
- `opencode upgrade` on that installation remains on `netsky-prod/opencode`.
- Existing core and OpenCode tests remain green.
