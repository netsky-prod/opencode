export * as SessionLoop from "./loop"

import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Identifier } from "../id/id"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { ADAPTIVE_FALLBACK_MS, initialNextRun, MAX_DELAY_MS, MIN_DELAY_MS, nextFixedBoundary } from "./loop-schedule"
import { SessionSchema } from "./schema"
import { SessionInputTable, SessionLoopTable, SessionTable } from "./sql"

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
  readonly nextRunAt?: number
  readonly state?: State
  readonly reason?: string | null
  readonly now?: number
}

type OwnedInput = { readonly sessionID: SessionSchema.ID; readonly id: ID }

export type Claim = {
  readonly loop: Info
  readonly messageID: SessionMessage.ID
}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, InvalidInput | SessionNotFound>
  readonly get: (input: OwnedInput) => Effect.Effect<Info, NotFound>
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly update: (input: UpdateInput) => Effect.Effect<Info, InvalidInput | NotFound>
  readonly remove: (input: OwnedInput) => Effect.Effect<boolean, NotFound>
  readonly claimDue: (input: {
    readonly owner: string
    readonly now: number
    readonly leaseMs: number
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<Claim>>
  readonly markAdmitted: (input: {
    readonly id: ID
    readonly messageID: SessionMessage.ID
    readonly now: number
  }) => Effect.Effect<void>
  readonly recordFailure: (input: {
    readonly id: ID
    readonly messageID: SessionMessage.ID
    readonly now: number
    readonly retryAt: number
    readonly error: string
  }) => Effect.Effect<void>
  readonly reconcilePending: (now: number) => Effect.Effect<number>
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
      if (input.nextRunAt !== undefined && (current.mode !== "adaptive" || !Number.isSafeInteger(input.nextRunAt))) {
        return yield* Effect.fail(new InvalidInput({ message: "Only adaptive loops accept an explicit wake-up" }))
      }
      const reactivated = state === "active" && current.state !== "active"
      const cadenceChanged = input.intervalMs !== undefined && input.intervalMs !== current.intervalMs
      const nextRunAt =
        state !== "active"
          ? null
          : input.nextRunAt !== undefined
            ? input.nextRunAt
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

    const claimDue = Effect.fn("SessionLoop.claimDue")(function* (input: {
      readonly owner: string
      readonly now: number
      readonly leaseMs: number
      readonly limit: number
    }) {
      if (input.limit <= 0 || input.leaseMs <= 0) return []
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const candidates = yield* tx
              .select()
              .from(SessionLoopTable)
              .where(
                and(
                  eq(SessionLoopTable.state, "active"),
                  lte(SessionLoopTable.next_run_at, input.now),
                  or(isNull(SessionLoopTable.lease_expires_at), lte(SessionLoopTable.lease_expires_at, input.now)),
                ),
              )
              .orderBy(asc(SessionLoopTable.next_run_at), asc(SessionLoopTable.id))
              .limit(input.limit)
              .all()

            const claims = new Array<Claim>()
            for (const candidate of candidates) {
              const pendingID =
                candidate.pending_message_id === null ? undefined : SessionMessage.ID.make(candidate.pending_message_id)
              const pending =
                pendingID === undefined
                  ? undefined
                  : yield* tx
                      .select({ promotedSeq: SessionInputTable.promoted_seq })
                      .from(SessionInputTable)
                      .where(eq(SessionInputTable.id, pendingID))
                      .get()

              if (pending?.promotedSeq === null) {
                const nextRunAt =
                  candidate.mode === "fixed"
                    ? nextFixedBoundary(candidate.next_run_at!, candidate.interval_ms!, input.now)
                    : input.now + ADAPTIVE_FALLBACK_MS
                yield* tx
                  .update(SessionLoopTable)
                  .set({
                    last_due_at: candidate.next_run_at,
                    next_run_at: nextRunAt,
                    lease_owner: null,
                    lease_expires_at: null,
                    time_updated: input.now,
                  })
                  .where(
                    and(
                      eq(SessionLoopTable.id, candidate.id),
                      eq(SessionLoopTable.state, "active"),
                      lte(SessionLoopTable.next_run_at, input.now),
                    ),
                  )
                  .run()
                continue
              }

              if (pending !== undefined && pending.promotedSeq !== null) {
                yield* tx
                  .update(SessionLoopTable)
                  .set({ pending_message_id: null })
                  .where(eq(SessionLoopTable.id, candidate.id))
                  .run()
              }

              const retry = pendingID !== undefined && pending === undefined
              const messageID = retry ? pendingID : SessionMessage.ID.create()
              const previousDue =
                retry && candidate.last_due_at !== null ? candidate.last_due_at : candidate.next_run_at!
              const nextRunAt =
                candidate.mode === "fixed"
                  ? nextFixedBoundary(previousDue, candidate.interval_ms!, input.now)
                  : input.now + ADAPTIVE_FALLBACK_MS
              const claimed = yield* tx
                .update(SessionLoopTable)
                .set({
                  pending_message_id: messageID,
                  last_due_at: retry ? candidate.last_due_at : candidate.next_run_at,
                  next_run_at: nextRunAt,
                  lease_owner: input.owner,
                  lease_expires_at: input.now + input.leaseMs,
                  time_updated: input.now,
                })
                .where(
                  and(
                    eq(SessionLoopTable.id, candidate.id),
                    eq(SessionLoopTable.state, "active"),
                    lte(SessionLoopTable.next_run_at, input.now),
                    or(isNull(SessionLoopTable.lease_expires_at), lte(SessionLoopTable.lease_expires_at, input.now)),
                  ),
                )
                .returning()
                .get()
              if (claimed) claims.push({ loop: fromRow(claimed), messageID })
            }
            return claims
          }),
        )
        .pipe(Effect.orDie)
    })

    const markAdmitted = Effect.fn("SessionLoop.markAdmitted")(function* (input: {
      readonly id: ID
      readonly messageID: SessionMessage.ID
      readonly now: number
    }) {
      yield* db
        .update(SessionLoopTable)
        .set({
          last_admitted_at: input.now,
          last_error: null,
          failure_count: 0,
          lease_owner: null,
          lease_expires_at: null,
          time_updated: input.now,
        })
        .where(and(eq(SessionLoopTable.id, input.id), eq(SessionLoopTable.pending_message_id, input.messageID)))
        .run()
        .pipe(Effect.orDie)
    })

    const recordFailure = Effect.fn("SessionLoop.recordFailure")(function* (input: {
      readonly id: ID
      readonly messageID: SessionMessage.ID
      readonly now: number
      readonly retryAt: number
      readonly error: string
    }) {
      yield* db
        .update(SessionLoopTable)
        .set({
          next_run_at: input.retryAt,
          last_error: input.error.slice(0, 2_000),
          failure_count: sql`${SessionLoopTable.failure_count} + 1`,
          lease_owner: null,
          lease_expires_at: null,
          time_updated: input.now,
        })
        .where(
          and(
            eq(SessionLoopTable.id, input.id),
            eq(SessionLoopTable.state, "active"),
            eq(SessionLoopTable.pending_message_id, input.messageID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const reconcilePending = Effect.fn("SessionLoop.reconcilePending")(function* (timestamp: number) {
      const rows = yield* db
        .select({ id: SessionLoopTable.id, pendingMessageID: SessionLoopTable.pending_message_id })
        .from(SessionLoopTable)
        .where(sql`${SessionLoopTable.pending_message_id} IS NOT NULL`)
        .all()
        .pipe(Effect.orDie)
      let reconciled = 0
      for (const row of rows) {
        const messageID = SessionMessage.ID.make(row.pendingMessageID!)
        const pending = yield* SessionInput.find(db, messageID)
        if (pending?.promotedSeq === undefined) continue
        const result = yield* db
          .update(SessionLoopTable)
          .set({
            pending_message_id: null,
            lease_owner: null,
            lease_expires_at: null,
            time_updated: timestamp,
          })
          .where(and(eq(SessionLoopTable.id, row.id), eq(SessionLoopTable.pending_message_id, messageID)))
          .returning({ id: SessionLoopTable.id })
          .get()
          .pipe(Effect.orDie)
        if (result) reconciled++
      }
      return reconciled
    })

    return Service.of({ create, get, list, update, remove, claimDue, markAdmitted, recordFailure, reconcilePending })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
