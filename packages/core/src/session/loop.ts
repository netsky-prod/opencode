export * as SessionLoop from "./loop"

import { and, asc, eq, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Identifier } from "../id/id"
import { SessionMessage } from "./message"
import { initialNextRun, MAX_DELAY_MS, MIN_DELAY_MS } from "./loop-schedule"
import { SessionSchema } from "./schema"
import { SessionLoopTable, SessionTable } from "./sql"

export const ID = Schema.String.check(Schema.isStartsWith("loop_")).pipe(Schema.brand("SessionLoop.ID"))
export type ID = typeof ID.Type

export const Mode = Schema.Literals(["fixed", "adaptive"])
export type Mode = typeof Mode.Type

export const State = Schema.Literals(["active", "paused", "completed"])
export type State = typeof State.Type

export type Info = {
  readonly id: ID
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

type CreateInput = {
  readonly sessionID: SessionSchema.ID
  readonly prompt: string
  readonly mode: Mode
  readonly intervalMs?: number
  readonly reason?: string
  readonly now?: number
}

type UpdateInput = {
  readonly sessionID: SessionSchema.ID
  readonly id: ID
  readonly prompt?: string
  readonly intervalMs?: number
  readonly state?: State
  readonly reason?: string | null
  readonly now?: number
}

type OwnedInput = { readonly sessionID: SessionSchema.ID; readonly id: ID }

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, InvalidInput | SessionNotFound>
  readonly get: (input: OwnedInput) => Effect.Effect<Info, NotFound>
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly update: (input: UpdateInput) => Effect.Effect<Info, InvalidInput | NotFound>
  readonly remove: (input: OwnedInput) => Effect.Effect<boolean, NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLoop") {}

const fromRow = (row: typeof SessionLoopTable.$inferSelect): Info => ({
  id: ID.make(row.id),
  sessionID: SessionSchema.ID.make(row.session_id),
  prompt: row.prompt,
  mode: row.mode,
  ...(row.interval_ms === null ? {} : { intervalMs: row.interval_ms }),
  state: row.state,
  ...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
  ...(row.last_due_at === null ? {} : { lastDueAt: row.last_due_at }),
  ...(row.last_admitted_at === null ? {} : { lastAdmittedAt: row.last_admitted_at }),
  ...(row.pending_message_id === null ? {} : { pendingMessageID: SessionMessage.ID.make(row.pending_message_id) }),
  ...(row.reason === null ? {} : { reason: row.reason }),
  ...(row.last_error === null ? {} : { lastError: row.last_error }),
  failureCount: row.failure_count,
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
})

const now = (input?: number) =>
  input === undefined ? DateTime.now.pipe(Effect.map(DateTime.toEpochMillis)) : Effect.succeed(input)

const validateSchedule = (mode: Mode, intervalMs?: number) => {
  if (mode === "adaptive" && intervalMs !== undefined) {
    return Effect.fail(new InvalidInput({ message: "Adaptive loops cannot have a fixed interval" }))
  }
  if (mode === "fixed" && intervalMs === undefined) {
    return Effect.fail(new InvalidInput({ message: "Fixed loops require an interval" }))
  }
  if (
    intervalMs !== undefined &&
    (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_DELAY_MS || intervalMs > MAX_DELAY_MS)
  ) {
    return Effect.fail(new InvalidInput({ message: "Interval must be between 10 seconds and 7 days" }))
  }
  return Effect.void
}

const normalizePrompt = (prompt: string) => {
  const value = prompt.trim()
  return value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(new InvalidInput({ message: "Loop prompt cannot be empty" }))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const owned = Effect.fn("SessionLoop.owned")(function* (input: OwnedInput) {
      const row = yield* db
        .select()
        .from(SessionLoopTable)
        .where(and(eq(SessionLoopTable.id, input.id), eq(SessionLoopTable.session_id, input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFound(input))
      return row
    })

    const create = Effect.fn("SessionLoop.create")(function* (input: CreateInput) {
      const prompt = yield* normalizePrompt(input.prompt)
      yield* validateSchedule(input.mode, input.intervalMs)
      const session = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return yield* Effect.fail(new SessionNotFound({ sessionID: input.sessionID }))

      const timestamp = yield* now(input.now)
      const row = yield* db
        .insert(SessionLoopTable)
        .values({
          id: Identifier.create("loop", "ascending", timestamp),
          session_id: input.sessionID,
          prompt,
          mode: input.mode,
          interval_ms: input.intervalMs,
          state: "active",
          next_run_at: initialNextRun(input.mode, timestamp, input.intervalMs),
          reason: input.reason?.trim() || null,
          time_created: timestamp,
          time_updated: timestamp,
        })
        .returning()
        .get()
        .pipe(Effect.orDie)
      return fromRow(row)
    })

    const get = Effect.fn("SessionLoop.get")(function* (input: OwnedInput) {
      return fromRow(yield* owned(input))
    })

    const list = Effect.fn("SessionLoop.list")(function* (sessionID: SessionSchema.ID) {
      const rows = yield* db
        .select()
        .from(SessionLoopTable)
        .where(eq(SessionLoopTable.session_id, sessionID))
        .orderBy(
          sql`CASE ${SessionLoopTable.state} WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END`,
          asc(SessionLoopTable.next_run_at),
          asc(SessionLoopTable.id),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const update = Effect.fn("SessionLoop.update")(function* (input: UpdateInput) {
      const current = fromRow(yield* owned(input))
      const timestamp = yield* now(input.now)
      const prompt = input.prompt === undefined ? current.prompt : yield* normalizePrompt(input.prompt)
      const intervalMs = input.intervalMs ?? current.intervalMs
      const mode = input.intervalMs === undefined ? current.mode : "fixed"
      yield* validateSchedule(mode, intervalMs)
      const state = input.state ?? current.state
      const reactivated = state === "active" && current.state !== "active"
      const cadenceChanged = input.intervalMs !== undefined && input.intervalMs !== current.intervalMs
      const nextRunAt =
        state !== "active"
          ? null
          : reactivated || cadenceChanged
            ? initialNextRun(mode, timestamp, intervalMs)
            : current.nextRunAt
      const reason = input.reason === undefined ? current.reason : input.reason?.trim() || null

      const row = yield* db
        .update(SessionLoopTable)
        .set({
          prompt,
          mode,
          interval_ms: intervalMs,
          state,
          next_run_at: nextRunAt,
          reason,
          ...(state === "active" ? {} : { lease_owner: null, lease_expires_at: null }),
          time_updated: timestamp,
        })
        .where(and(eq(SessionLoopTable.id, input.id), eq(SessionLoopTable.session_id, input.sessionID)))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFound({ sessionID: input.sessionID, id: input.id }))
      return fromRow(row)
    })

    const remove = Effect.fn("SessionLoop.remove")(function* (input: OwnedInput) {
      const current = fromRow(yield* owned(input))
      yield* db
        .delete(SessionLoopTable)
        .where(and(eq(SessionLoopTable.id, input.id), eq(SessionLoopTable.session_id, input.sessionID)))
        .run()
        .pipe(Effect.orDie)
      return current.pendingMessageID !== undefined
    })

    return Service.of({ create, get, list, update, remove })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
