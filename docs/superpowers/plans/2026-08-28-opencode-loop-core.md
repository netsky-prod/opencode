# OpenCode Durable Loop Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable `/loop` scheduler, model tools, and built-in command to the OpenCode fork.

**Architecture:** Persist loop state in core SQLite, isolate cadence calculations in pure functions, and run one global Effect scheduler that admits deterministic V2 prompts with `delivery: "queue"`. Location-scoped built-in tools manage the global store; the existing command registry exposes a prompt template that calls those tools.

**Tech Stack:** TypeScript, Bun, Effect, Drizzle SQLite, OpenCode V2 Session APIs, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-28-opencode-loop-design.md`

## Global Constraints

- Fixed durations accept `s`, `m`, `h`, and `d`, minimum 10 seconds and maximum 7 days.
- Scheduled work uses `SessionV2.prompt` with `delivery: "queue"` and never legacy `SessionPrompt.loop`.
- Each loop has at most one unpromoted scheduled input.
- Missed fixed intervals coalesce to the first cadence boundary strictly after now.
- Adaptive loops use a 10-minute fallback and may reschedule, pause, or complete themselves.
- Loops never expire automatically and run only while OpenCode is running.
- This plan adds no public HTTP API or generated SDK change.
- Scheduler tests use Effect `TestClock`, never wall-clock sleeps.
- Run package tests from package directories, not the repository root.

---

## File map

- `packages/core/src/session/loop-schedule.ts` — duration parser and cadence math.
- `packages/core/src/session/loop.ts` — schemas, CRUD, transitions, claims, and reconciliation.
- `packages/core/src/session/loop-scheduler.ts` — bounded tick, prompt admission, retry, background fiber.
- `packages/core/src/session/sql.ts` — `session_loop` table.
- `packages/core/src/database/migration/20260828210000_session_loop.ts` — loop migration.
- `packages/core/src/tool/loop.ts` — five loop tools.
- `packages/core/src/tool/builtins.ts` — tool wiring.
- `packages/opencode/src/command/template/loop.txt` and `packages/opencode/src/command/index.ts` — slash command.
- `packages/opencode/src/server/routes/instance/httpapi/server.ts` — scheduler boot.
- `packages/core/test/session-loop-schedule.test.ts` — parser/cadence.
- `packages/core/test/session-loop.test.ts` — store and state machine.
- `packages/core/test/session-loop-scheduler.test.ts` — scheduler behavior.
- `packages/core/test/tool-loop.test.ts` — tools and permissions.
- `packages/opencode/test/command-loop.test.ts` — command contract.
- `docs/loop.md` — user documentation.

### Task 1: Pure duration and cadence rules

**Files:**

- Create: `packages/core/src/session/loop-schedule.ts`
- Test: `packages/core/test/session-loop-schedule.test.ts`

**Interfaces:**

- Consumes: no feature code.
- Produces `MIN_DELAY_MS`, `MAX_DELAY_MS`, `ADAPTIVE_FALLBACK_MS`, `parseDelay(value: string): number`, `nextFixedBoundary(previousDue: number, intervalMs: number, now: number): number`, and `initialNextRun(mode, now, intervalMs?): number`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test"
import {
  ADAPTIVE_FALLBACK_MS,
  initialNextRun,
  nextFixedBoundary,
  parseDelay,
} from "@opencode-ai/core/session/loop-schedule"

describe("loop schedule", () => {
  test.each([
    ["10s", 10_000],
    ["5m", 300_000],
    ["2h", 7_200_000],
    ["7d", 604_800_000],
  ])("parses %s", (input, expected) => expect(parseDelay(input)).toBe(expected))
  test.each(["9s", "8d", "1.5m", "10 minutes", "1h30m", "", "-1m"])("rejects %s", (input) => {
    expect(() => parseDelay(input)).toThrow()
  })
  test("coalesces missed boundaries", () => {
    expect(nextFixedBoundary(100_000, 60_000, 100_001)).toBe(160_000)
    expect(nextFixedBoundary(100_000, 60_000, 399_999)).toBe(400_000)
    expect(nextFixedBoundary(100_000, 60_000, 400_000)).toBe(460_000)
  })
  test("creates initial wake-ups", () => {
    expect(initialNextRun("fixed", 1_000, 60_000)).toBe(61_000)
    expect(initialNextRun("adaptive", 1_000)).toBe(1_000)
    expect(ADAPTIVE_FALLBACK_MS).toBe(600_000)
  })
})
```

- [ ] **Step 2: Run RED**

From `packages/core` run:

```bash
bun test test/session-loop-schedule.test.ts --timeout 30000 --only-failures
```

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement the pure module**

```ts
export const MIN_DELAY_MS = 10_000
export const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1_000
export const ADAPTIVE_FALLBACK_MS = 10 * 60 * 1_000
const units = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

export function parseDelay(value: string) {
  const match = /^([1-9]\d*)(s|m|h|d)$/.exec(value.trim())
  if (!match) throw new Error("Duration must be one positive integer followed by s, m, h, or d")
  const result = Number(match[1]) * units[match[2] as keyof typeof units]
  if (!Number.isSafeInteger(result) || result < MIN_DELAY_MS || result > MAX_DELAY_MS)
    throw new Error("Duration must be between 10s and 7d")
  return result
}

export function nextFixedBoundary(previousDue: number, intervalMs: number, now: number) {
  if (intervalMs < MIN_DELAY_MS || intervalMs > MAX_DELAY_MS) throw new Error("Invalid loop interval")
  return previousDue + (Math.floor(Math.max(0, now - previousDue) / intervalMs) + 1) * intervalMs
}

export function initialNextRun(mode: "fixed" | "adaptive", now: number, intervalMs?: number) {
  if (mode === "adaptive") return now
  if (intervalMs === undefined) throw new Error("Fixed loops require an interval")
  return now + intervalMs
}
```

- [ ] **Step 4: Run GREEN**

Run: `bun test test/session-loop-schedule.test.ts --timeout 30000 --only-failures`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/loop-schedule.ts packages/core/test/session-loop-schedule.test.ts
git commit -m "feat(core): add loop schedule rules"
```

### Task 2: Persisted schema and CRUD service

**Files:**

- Modify: `packages/core/src/session/sql.ts`
- Create: `packages/core/src/session/loop.ts`
- Create: `packages/core/test/session-loop.test.ts`
- Create: `packages/core/src/database/migration/20260828210000_session_loop.ts`
- Modify: `packages/core/src/database/migration.gen.ts`
- Modify: `packages/core/src/database/schema.gen.ts`
- Modify: `packages/core/schema.json`

**Interfaces:**

- Consumes `initialNextRun` and duration bounds.
- Produces branded `SessionLoop.ID`; `Mode = "fixed" | "adaptive"`; `State = "active" | "paused" | "completed"`; `Info`; typed `InvalidInput`, `SessionNotFound`, and `NotFound` errors; and `Service` methods `create`, `get`, `list`, `update`, and `remove`.

```ts
export type Info = {
  readonly id: LoopID
  readonly sessionID: SessionSchema.ID
  readonly prompt: string
  readonly mode: Mode
  readonly intervalMs?: number
  readonly state: State
  readonly nextRunAt?: number
  readonly lastDueAt?: number
  readonly lastAdmittedAt?: number
  readonly pendingMessageID?: SessionMessage.ID
  readonly reason?: string
  readonly lastError?: string
  readonly failureCount: number
  readonly timeCreated: number
  readonly timeUpdated: number
}
```

- [ ] **Step 1: Write failing CRUD tests**

Build `AppNodeBuilder.build(LayerNode.group([Database.node, SessionLoop.node]))`, insert a project/session like `test/session-todo.test.ts`, and assert:

```ts
const created =
  yield *
  loops.create({
    sessionID,
    prompt: "Check CI",
    mode: "fixed",
    intervalMs: 60_000,
    reason: "CI may finish",
    now: 1_000,
  })
expect(created).toMatchObject({
  sessionID,
  prompt: "Check CI",
  mode: "fixed",
  intervalMs: 60_000,
  state: "active",
  nextRunAt: 61_000,
})
expect(yield * loops.list(sessionID)).toEqual([created])
expect((yield * loops.get({ sessionID, id: created.id })).id).toBe(created.id)
expect(yield * Effect.flip(loops.get({ sessionID: otherSessionID, id: created.id }))).toBeInstanceOf(
  SessionLoop.NotFound,
)
```

Add assertions that adaptive creation writes `nextRunAt = now`; invalid mode/interval pairs and an empty trimmed prompt fail with `InvalidInput`; a missing session fails with `SessionNotFound`; listing orders active rows by `nextRunAt` then ID; an ID owned by another session fails with `NotFound`; removal empties the list; and deleting `SessionTable` cascades the matching loop row.

- [ ] **Step 2: Run RED**

Run: `bun test test/session-loop.test.ts --timeout 30000 --only-failures`

Expected: FAIL on missing table/service.

- [ ] **Step 3: Add `SessionLoopTable`**

```ts
export const SessionLoopTable = sqliteTable(
  "session_loop",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text().notNull(),
    mode: text().$type<"fixed" | "adaptive">().notNull(),
    interval_ms: integer(),
    state: text().$type<"active" | "paused" | "completed">().notNull(),
    next_run_at: integer(),
    last_due_at: integer(),
    last_admitted_at: integer(),
    pending_message_id: text().$type<SessionMessage.ID>(),
    reason: text(),
    last_error: text(),
    failure_count: integer().notNull().default(0),
    lease_owner: text(),
    lease_expires_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("session_loop_due_idx").on(table.state, table.next_run_at),
    index("session_loop_session_state_idx").on(table.session_id, table.state),
    uniqueIndex("session_loop_pending_message_idx").on(table.pending_message_id),
    check(
      "session_loop_mode_interval_check",
      sql`(mode = 'fixed' AND interval_ms IS NOT NULL) OR (mode = 'adaptive' AND interval_ms IS NULL)`,
    ),
    check(
      "session_loop_state_next_check",
      sql`(state = 'active' AND next_run_at IS NOT NULL) OR (state != 'active' AND next_run_at IS NULL)`,
    ),
  ],
)
```

Import `sql` from `drizzle-orm` and `check` from `drizzle-orm/sqlite-core`.

- [ ] **Step 4: Generate migration artifacts**

From `packages/core`:

```bash
bun script/migration.ts --name session_loop
```

Rename the generated `*_session_loop.ts` to `src/database/migration/20260828210000_session_loop.ts`, change its exported ID and `migration.gen.ts` import to `20260828210000_session_loop`, then run `bun script/migration.ts --check`. Expected: exit 0.

- [ ] **Step 5: Implement CRUD**

Use:

```ts
export const ID = Schema.String.check(Schema.isStartsWith("loop_")).pipe(Schema.brand("SessionLoop.ID"))
export type LoopID = typeof ID.Type

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("SessionLoop.NotFound", {
  sessionID: SessionSchema.ID,
  id: ID,
}) {}

export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()("SessionLoop.InvalidInput", {
  message: Schema.String,
}) {}

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("SessionLoop.SessionNotFound", {
  sessionID: SessionSchema.ID,
}) {}
```

Generate IDs with `Identifier.create("loop", "ascending")`. Decode rows in one `fromRow`. Every owned read/write includes:

```ts
where(and(eq(SessionLoopTable.id, input.id), eq(SessionLoopTable.session_id, input.sessionID)))
```

Use `makeGlobalNode` with `Database.node`. Before create, query `SessionTable` and return `SessionNotFound` when absent. Trim prompt/reason and validate all mode/interval combinations before writes.

- [ ] **Step 6: Run GREEN**

```bash
bun test test/session-loop-schedule.test.ts test/session-loop.test.ts --timeout 30000 --only-failures
bun script/migration.ts --check
```

Expected: tests and migration check pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/session/sql.ts packages/core/src/session/loop.ts packages/core/test/session-loop.test.ts packages/core/schema.json packages/core/src/database/schema.gen.ts packages/core/src/database/migration.gen.ts packages/core/src/database/migration/20260828210000_session_loop.ts
git commit -m "feat(core): persist session loops"
```

### Task 3: Atomic claims and pending reconciliation

**Files:**

- Modify: `packages/core/src/session/loop.ts`
- Modify: `packages/core/test/session-loop.test.ts`

**Interfaces:**

- Consumes `SessionInput.find` and `nextFixedBoundary`.
- Produces `Claim { loop: Info; messageID: SessionMessage.ID }` and service methods `claimDue({ owner, now, leaseMs, limit })`, `markAdmitted`, `recordFailure`, and `reconcilePending(now)`.

- [ ] **Step 1: Add failing state-machine tests**

```ts
const [claim] = yield * loops.claimDue({ owner: "one", now: 61_000, leaseMs: 30_000, limit: 10 })
expect(claim.loop.nextRunAt).toBe(121_000)
expect(claim.loop.pendingMessageID).toBe(claim.messageID)
expect(yield * loops.claimDue({ owner: "two", now: 61_000, leaseMs: 30_000, limit: 10 })).toEqual([])

yield *
  loops.recordFailure({
    id: claim.loop.id,
    messageID: claim.messageID,
    now: 61_001,
    retryAt: 66_001,
    error: "provider unavailable",
  })
const [retried] = yield * loops.claimDue({ owner: "two", now: 66_001, leaseMs: 30_000, limit: 10 })
expect(retried.messageID).toBe(claim.messageID)
```

Also assert: unpromoted input coalesces without another ID; promoted input clears pending; adaptive claim installs `now + 600_000`; pause clears scheduling/lease; fixed resume uses `now + interval`; adaptive resume is due now; completion retains reason; concurrent claim effects return one claim total.

- [ ] **Step 2: Run RED**

Run: `bun test test/session-loop.test.ts --timeout 30000 --only-failures`

Expected: FAIL on missing claim methods.

- [ ] **Step 3: Implement compare-and-set claims**

Query due rows ordered by `next_run_at` and `id`. In a transaction update each candidate only if active, due, and unleased/expired:

```ts
const claimed =
  yield *
  tx
    .update(SessionLoopTable)
    .set({
      pending_message_id: messageID,
      last_due_at: row.next_run_at,
      next_run_at: next,
      lease_owner: input.owner,
      lease_expires_at: input.now + input.leaseMs,
      time_updated: input.now,
    })
    .where(
      and(
        eq(SessionLoopTable.id, row.id),
        eq(SessionLoopTable.state, "active"),
        lte(SessionLoopTable.next_run_at, input.now),
        or(isNull(SessionLoopTable.lease_expires_at), lte(SessionLoopTable.lease_expires_at, input.now)),
      ),
    )
    .returning()
    .get()
```

Reuse an existing pending ID after admission failure. Use `SessionInput.find`: promoted clears pending; unpromoted advances cadence but returns no claim.

- [ ] **Step 4: Implement bookkeeping and state transitions**

`recordFailure` retains the message ID, increments `failure_count`, bounds `last_error` to 2,000 characters, sets `next_run_at = retryAt`, and clears lease fields. `markAdmitted` sets admission time, resets failure count, and clears only lease fields. Pause/resume/complete are owned compare-and-set updates.

- [ ] **Step 5: Run GREEN**

Run: `bun test test/session-loop.test.ts --timeout 30000 --only-failures`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/session/loop.ts packages/core/test/session-loop.test.ts
git commit -m "feat(core): claim loop invocations atomically"
```

### Task 4: Scheduler tick and queued V2 admission

**Files:**

- Create: `packages/core/src/session/loop-scheduler.ts`
- Create: `packages/core/test/session-loop-scheduler.test.ts`

**Interfaces:**

- Consumes `SessionLoop` claim/bookkeeping methods and `SessionV2.Interface.prompt`.
- Produces `Service { tick: Effect.Effect<void> }`, `makeLayer({ owner?, batchSize?, leaseMs?, startBackground? })`, and `node`.

- [ ] **Step 1: Write failing scheduler tests**

Use a fake `SessionV2.Service` to capture calls:

```ts
yield * scheduler.tick
expect(promptCalls).toEqual([
  {
    id: claimMessageID,
    sessionID,
    delivery: "queue",
    prompt: { text: expect.stringContaining("[Scheduled loop") },
  },
])
```

Add cases for deterministic retry ID, adaptive wrapper naming `loop_wakeup`, fixed wrapper naming `loop_update`, missing session completion, capped exponential backoff, batch limit 32, and `TestClock.adjust("1 second")` driving the background fiber.

- [ ] **Step 2: Run RED**

Run: `bun test test/session-loop-scheduler.test.ts --timeout 30000 --only-failures`

Expected: FAIL because the scheduler is absent.

- [ ] **Step 3: Implement wrapping and `tick`**

```ts
function wrap(loop: SessionLoop.Info) {
  const control =
    loop.mode === "adaptive"
      ? "Before finishing, call loop_wakeup with schedule, pause, or complete. Without it, fallback is 10 minutes."
      : "When genuinely complete or blocked on the user, call loop_update with state completed."
  return [
    "Scheduled loop " + loop.id,
    "Mode: " + loop.mode,
    loop.reason ? "Reason: " + loop.reason : undefined,
    "",
    loop.prompt,
    "",
    control,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}
```

Read `Clock.currentTimeMillis`, reconcile, claim up to 32, then:

```ts
yield *
  sessions.prompt({
    id: claim.messageID,
    sessionID: claim.loop.sessionID,
    prompt: { text: wrap(claim.loop) },
    delivery: "queue",
  })
```

Process claims with concurrency 4. Retry at `now + min(300_000, 1_000 * 2 ** failureCount)`. Complete missing sessions; record other failures.

- [ ] **Step 4: Start one scoped fiber**

```ts
yield *
  service.tick.pipe(
    Effect.catchAllCause((cause) => Effect.logError("Loop scheduler tick failed", cause)),
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.forkScoped({ startImmediately: true }),
  )
```

Skip it only when tests pass `startBackground: false`. The global node depends on `SessionLoop.node` and `SessionV2.node`. Its default owner is created once per layer acquisition with `crypto.randomUUID()`; tests pass a fixed owner.

- [ ] **Step 5: Run GREEN**

```bash
bun test test/session-loop.test.ts test/session-loop-scheduler.test.ts --timeout 30000 --only-failures
bun script/migration.ts --check
```

Expected: tests and migration check pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/session/loop-scheduler.ts packages/core/test/session-loop-scheduler.test.ts
git commit -m "feat(core): schedule queued loop prompts"
```

### Task 5: Built-in loop management tools

**Files:**

- Create: `packages/core/src/tool/loop.ts`
- Modify: `packages/core/src/tool/builtins.ts`
- Create: `packages/core/test/tool-loop.test.ts`
- Modify: `packages/core/test/location-layer.test.ts`

**Interfaces:**

- Consumes `SessionLoop.Service` and `parseDelay`.
- Produces tools `loop_create`, `loop_list`, `loop_update`, `loop_delete`, and `loop_wakeup`.

- [ ] **Step 1: Write failing registry and behavior tests**

Build a graph with `Database`, `SessionLoop`, `ToolRegistry`, `ToolOutputStore.nodeWithoutConfig`, `LoopTool.node`, and a fake `PermissionV2.Service`. Assert:

```ts
expect((yield * toolDefinitions(registry)).map((tool) => tool.name).sort()).toEqual([
  "loop_create",
  "loop_delete",
  "loop_list",
  "loop_update",
  "loop_wakeup",
])
```

Use `settleTool` to prove: fixed create parses `10m`; adaptive create is due immediately; list is current-session only; cross-session IDs return a tool error; pause/resume/complete transition correctly; wake-up replaces adaptive fallback; delete reports pending admission; denied mutation leaves storage unchanged; mutation permission is `{ action: "loop", resources: [idOrNew], save: ["*"] }`.

- [ ] **Step 2: Run RED**

Run: `bun test test/tool-loop.test.ts --timeout 30000 --only-failures`

Expected: FAIL because `LoopTool` is absent.

- [ ] **Step 3: Define exact tool schemas**

```ts
export const CreateInput = Schema.Struct({
  prompt: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
  schedule: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("fixed"), every: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("adaptive") }),
  ]),
  reason: Schema.optional(Schema.String),
})

export const UpdateInput = Schema.Struct({
  id: SessionLoop.ID,
  prompt: Schema.optional(Schema.String),
  every: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Literals(["active", "paused", "completed"])),
  reason: Schema.optional(Schema.String),
})

export const WakeupInput = Schema.Union([
  Schema.Struct({
    id: SessionLoop.ID,
    action: Schema.Literal("schedule"),
    in: Schema.String,
    reason: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
  }),
  Schema.Struct({
    id: SessionLoop.ID,
    action: Schema.Literals(["pause", "complete"]),
    reason: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
  }),
])
```

`loop_list` uses `Schema.Struct({})`; `loop_delete` uses `{ id: SessionLoop.ID }`.

- [ ] **Step 4: Register and implement all tools**

Register once through `Tools.Service`. Assert permission before every mutation and never before list. Convert owned service errors to `ToolFailure` without revealing another session.

Use readable output:

```ts
function summary(loop: SessionLoop.Info) {
  const next = loop.nextRunAt === undefined ? "none" : new Date(loop.nextRunAt).toLocaleString()
  return [
    "Loop " + loop.id,
    "state: " + loop.state,
    "mode: " + loop.mode,
    "next: " + next,
    loop.reason ? "reason: " + loop.reason : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}
```

Export `LoopTool.node` with dependencies `ToolRegistry.node`, `PermissionV2.node`, and `SessionLoop.node`.

- [ ] **Step 5: Wire built-ins and inventory**

Add `LoopTool.node` to `BuiltInTools.node`. Its declared `SessionLoop.node` dependency is hoisted automatically when `locationServices` is compiled. Update the exact built-in arrays in `test/location-layer.test.ts` with all five names.

- [ ] **Step 6: Run GREEN**

```bash
bun test test/tool-loop.test.ts test/location-layer.test.ts --timeout 30000 --only-failures
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tool/loop.ts packages/core/src/tool/builtins.ts packages/core/test/tool-loop.test.ts packages/core/test/location-layer.test.ts
git commit -m "feat(core): add loop management tools"
```

### Task 6: Built-in `/loop` command

**Files:**

- Create: `packages/opencode/src/command/template/loop.txt`
- Modify: `packages/opencode/src/command/index.ts`
- Create: `packages/opencode/test/command-loop.test.ts`

**Interfaces:**

- Consumes the five tool names.
- Produces `Command.Default.LOOP = "loop"` and exported `LOOP_TEMPLATE`.

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, test } from "bun:test"
import { Command } from "../src/command"

describe("built-in loop command", () => {
  test("advertises arguments and operations", () => {
    expect(Command.Default.LOOP).toBe("loop")
    expect(Command.hints(Command.LOOP_TEMPLATE)).toEqual(["$ARGUMENTS"])
    for (const tool of ["loop_create", "loop_list", "loop_update", "loop_delete", "loop_wakeup"])
      expect(Command.LOOP_TEMPLATE).toContain(tool)
    for (const form of ["/loop <duration> <prompt>", "/loop <prompt>", "/loop <duration>", "/loop -- <prompt>"])
      expect(Command.LOOP_TEMPLATE).toContain(form)
  })
})
```

- [ ] **Step 2: Run RED**

From `packages/opencode` run:

```bash
bun test test/command-loop.test.ts --timeout 30000 --only-failures
```

Expected: FAIL because exports are absent.

- [ ] **Step 3: Write `loop.txt`**

```text
Configure a durable loop for the current OpenCode session from these exact user arguments:

$ARGUMENTS

Supported forms:
- /loop <duration> <prompt>: call loop_create with a fixed schedule.
- /loop <prompt>: call loop_create with an adaptive schedule.
- /loop <duration>: call loop_create with a fixed schedule and the maintenance prompt below.
- /loop with no arguments: call loop_create with an adaptive schedule and the maintenance prompt below.
- /loop list: call loop_list.
- /loop pause <id>: call loop_update with state paused.
- /loop resume <id>: call loop_update with state active.
- /loop delete <id>: call loop_delete.
- /loop -- <prompt>: remove the leading "-- " and create an adaptive loop.

Durations are one positive integer plus s, m, h, or d. Do not guess invalid input.
Only configure or manage the loop in this turn. Do not execute its task now.

Maintenance prompt:
Continue the current task from where it stopped. Inspect the latest state, make the next useful progress, and verify your work. If the task is genuinely complete or cannot progress without the user, stop this loop and explain why.

After success, report ID, state, cadence, next run, and that OpenCode must remain running.
```

- [ ] **Step 4: Register the command**

Import/export `LOOP_TEMPLATE`, add `LOOP` to `Default`, and insert:

```ts
commands[Default.LOOP] = {
  name: Default.LOOP,
  description: "schedule durable recurring work for this session",
  source: "command",
  template: LOOP_TEMPLATE,
  hints: hints(LOOP_TEMPLATE),
}
```

- [ ] **Step 5: Run GREEN**

```bash
bun test test/command-loop.test.ts --timeout 30000 --only-failures
bun run typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/command/template/loop.txt packages/opencode/src/command/index.ts packages/opencode/test/command-loop.test.ts
git commit -m "feat(opencode): add durable loop command"
```

### Task 7: Boot the scheduler in server-backed flows

**Files:**

- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts`
- Modify: `packages/core/test/session-loop-scheduler.test.ts`
- Create: `packages/opencode/test/server/loop-scheduler.test.ts`

**Interfaces:**

- Consumes `SessionLoopScheduler.node`, `SessionV2.node`, `LocationServiceMap.node`, and `SessionExecutionLocal.node`.
- Produces one scoped scheduler per acquired server layer.

- [ ] **Step 1: Add a failing lifecycle test**

In the core test, acquire the scheduler group, create one overdue loop, advance `TestClock`, and assert:

```ts
yield * TestClock.adjust("1 second")
yield * Effect.yieldNow
expect(promptCalls).toHaveLength(1)
expect(promptCalls[0]?.delivery).toBe("queue")
```

Add a behavioral server integration test, following
`test/server/httpapi-v2-location.test.ts`:

```ts
test("admits an overdue loop exactly once through the real server graph", async () => {
  await using tmp = await tmpdir({ git: true })
  const response = await request("/session", tmp.path, { method: "POST" })
  const session = (await response.json()) as { id: string }

  const sqlite = new SQLite(CoreDatabase.path())
  try {
    const now = Date.now()
    sqlite
      .query(
        `INSERT INTO session_loop
          (id, session_id, prompt, mode, interval_ms, state, next_run_at,
           failure_count, time_created, time_updated)
         VALUES (?, ?, ?, 'fixed', ?, 'active', ?, 0, ?, ?)`,
      )
      .run("loop_server_test", session.id, "Continue integration test", 10_000, now - 1, now, now)

    const admitted = await Effect.runPromise(
      pollWithTimeout(
        Effect.sync(
          () =>
            sqlite.query("SELECT id, delivery FROM session_input WHERE session_id = ?").all(session.id)[0] as
              | { id: string; delivery: string }
              | undefined,
        ),
        "scheduler did not admit queued input",
      ),
    )
    expect(admitted.delivery).toBe("queue")

    await Bun.sleep(1_200)
    const count = sqlite.query("SELECT count(*) AS count FROM session_input WHERE session_id = ?").get(session.id) as {
      count: number
    }
    expect(count.count).toBe(1)
  } finally {
    sqlite.close()
  }
})
```

Import `Database as SQLite` from `bun:sqlite`, the core database as
`CoreDatabase`, `Effect`, and `pollWithTimeout`. Reuse the real `HttpApiApp`,
request helper, `tmpdir`, `disposeAllInstances`, and `resetDatabase`. This test
observes behavior through the assembled server layer; it must not inspect
production source text.

- [ ] **Step 2: Run RED**

```bash
cd packages/core && bun test test/session-loop-scheduler.test.ts --timeout 30000 --only-failures
cd ../opencode && bun test test/server/loop-scheduler.test.ts --timeout 30000 --only-failures
```

Expected: the lifecycle assertion or behavioral integration test fails because
server wiring is absent.

- [ ] **Step 3: Group SessionV2 and scheduler**

Replace the standalone SessionV2 build with:

```ts
Layer.provide(
  AppNodeBuilderV1.build(LayerNode.group([SessionV2.node, SessionLoopScheduler.node]), [
    [LocationServiceMap.node, locationServiceMapV2],
    [SessionExecution.node, SessionExecutionLocal.node],
  ]),
),
```

Import `SessionLoopScheduler`. Remove the old standalone build so SessionV2 is not acquired twice.

- [ ] **Step 4: Run GREEN**

Run both commands from Step 2. Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/server.ts packages/core/test/session-loop-scheduler.test.ts packages/opencode/test/server/loop-scheduler.test.ts
git commit -m "feat(opencode): boot the loop scheduler"
```

### Task 8: Documentation and core verification

**Files:**

- Create: `docs/loop.md`
- Modify: `README.md`

**Interfaces:**

- Consumes shipped grammar and semantics.
- Produces user documentation and final evidence for the core slice.

- [ ] **Step 1: Write documentation**

```markdown
# Durable loops

`/loop` schedules another turn in the current session. OpenCode must remain running; closing every OpenCode process pauses the scheduler.

## Examples

- `/loop 10m check CI and fix the next failure`
- `/loop investigate the flaky test and choose when to check again`
- `/loop 30m`
- `/loop list`
- `/loop pause loop_...`
- `/loop resume loop_...`
- `/loop delete loop_...`

Fixed loops coalesce missed intervals and keep at most one queued invocation. Adaptive loops choose their next wake-up and use a 10-minute fallback. Schedules survive restart because they are stored with session data.

Deleting a loop prevents future admission, but a prompt already admitted to the durable inbox may execute once.
```

Add one “Fork features” link to `docs/loop.md` near the README usage section.

- [ ] **Step 2: Run focused verification**

From `packages/core`:

```bash
bun test test/session-loop-schedule.test.ts test/session-loop.test.ts test/session-loop-scheduler.test.ts test/tool-loop.test.ts test/location-layer.test.ts --timeout 30000 --only-failures
bun script/migration.ts --check
bun run typecheck
```

From `packages/opencode`:

```bash
bun test test/command-loop.test.ts test/server/loop-scheduler.test.ts --timeout 30000 --only-failures
bun run typecheck
```

Expected: every command exits 0.

- [ ] **Step 3: Run full regressions**

```bash
cd packages/core && bun test --timeout 30000 --only-failures
cd ../opencode && bun test --timeout 30000 --only-failures
```

Expected: both pass. If the known PTY poll fails only under suite load, rerun its exact test name once and preserve both outputs before deciding whether product code is implicated.

- [ ] **Step 4: Commit**

```bash
git add docs/loop.md README.md
git commit -m "docs: explain durable loops"
```

- [ ] **Step 5: Verify branch state**

```bash
git status --short --branch
git log --oneline --decorate -12
```

Expected: clean `loop-scheduler` with eight implementation commits after design/plan commits.
