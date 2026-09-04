export * as SessionLoopDispatch from "./loop-dispatch"

import { and, asc, eq, isNotNull, isNull, lte, or } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionV2 } from "../session"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { SessionLoop } from "./loop"
import { SessionInputTable, SessionLoopTable } from "./sql"

export interface Interface {
  readonly prompt: SessionV2.Interface["prompt"]
  readonly recover: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLoopDispatch") {}

/** Pending admission is durable; waking its owning execution driver is advisory. */
export const recover = (db: Database.Interface["db"], loops: SessionLoop.Interface, prompt: Interface["prompt"]) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const owner = crypto.randomUUID()
    const eligible = and(
      or(isNull(SessionLoopTable.lease_expires_at), lte(SessionLoopTable.lease_expires_at, now)),
      or(
        eq(SessionLoopTable.failure_count, 0),
        lte(SessionLoopTable.next_run_at, now),
        // A claimed retry can commit admission and die before markAdmitted
        // clears an earlier failure. Its expired lease, not the advanced
        // cadence, governs recovery. recordFailure clears lease_owner, so a
        // newer materialization failure still observes its retry backoff.
        isNotNull(SessionLoopTable.lease_owner),
      ),
    )
    const rows = yield* db
      .select({ input: SessionInputTable, loop: SessionLoopTable })
      .from(SessionLoopTable)
      .innerJoin(SessionInputTable, eq(SessionInputTable.id, SessionLoopTable.pending_message_id))
      .where(and(isNull(SessionInputTable.promoted_seq), eligible))
      .orderBy(asc(SessionInputTable.admitted_seq))
      .limit(32)
      .all()
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const claimed = yield* db
            .update(SessionLoopTable)
            .set({ lease_owner: owner, lease_expires_at: now + 30000 })
            .where(
              and(
                eq(SessionLoopTable.id, row.loop.id),
                eq(SessionLoopTable.pending_message_id, row.input.id),
                eligible,
              ),
            )
            .returning({ id: SessionLoopTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!claimed) return
          const input = yield* SessionInput.find(db, SessionMessage.ID.make(row.input.id))
          if (!input || input.promotedSeq !== undefined) return
          yield* prompt({
            id: input.id,
            sessionID: input.sessionID,
            prompt: input.prompt,
            delivery: input.delivery,
          }).pipe(
            Effect.andThen(
              loops.markAdmitted({
                id: SessionLoop.ID.make(row.loop.id),
                messageID: input.id,
                now,
                holdLease: true,
                expectedFailureCount: row.loop.failure_count,
              }),
            ),
            Effect.catchCause((cause) =>
              loops.recordFailure({
                id: SessionLoop.ID.make(row.loop.id),
                messageID: input.id,
                now,
                retryAt: now + Math.min(300000, 1000 * 2 ** Math.min(row.loop.failure_count, 20)),
                error: Cause.pretty(cause),
              }),
            ),
          )
        }),
      { concurrency: 4, discard: true },
    )
  })

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      const loops = yield* SessionLoop.Service
      return Service.of({ prompt: sessions.prompt, recover: recover(database.db, loops, sessions.prompt) })
    }),
  ),
  deps: [SessionV2.node, Database.node, SessionLoop.node],
})
