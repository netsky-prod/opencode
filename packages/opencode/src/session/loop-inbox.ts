export * as SessionLoopInbox from "./loop-inbox"

import { and, asc, eq, isNotNull, isNull, lte, or } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionInput } from "@opencode-ai/core/session/input"
import { MessageTable, PartTable, SessionInputTable, SessionLoopTable } from "@opencode-ai/core/session/sql"
import { SessionLoop } from "@opencode-ai/core/session/loop"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID, MessageID, PartID } from "./schema"
import { Session } from "./session"

export interface Interface {
  /** Projects one queued input at an idle boundary. Does not run the model. */
  readonly next: (sessionID: SessionID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLoopInbox") {}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const loops = yield* SessionLoop.Service
      const db = database.db
      const next: Interface["next"] = Effect.fn("SessionLoopInbox.next")(function* (sessionID) {
        const now = yield* Clock.currentTimeMillis
        const pending = yield* db
          .select({ id: SessionInputTable.id, loop: SessionLoopTable.id, failureCount: SessionLoopTable.failure_count })
          .from(SessionInputTable)
          .innerJoin(SessionLoopTable, eq(SessionLoopTable.pending_message_id, SessionInputTable.id))
          .where(
            and(
              eq(SessionInputTable.session_id, sessionID),
              eq(SessionInputTable.delivery, "queue"),
              isNull(SessionInputTable.promoted_seq),
              or(
                eq(SessionLoopTable.failure_count, 0),
                lte(SessionLoopTable.next_run_at, now),
                // An active claimed retry may wake before markAdmitted clears
                // the previous failure. A new failure clears this lease owner.
                isNotNull(SessionLoopTable.lease_owner),
              ),
            ),
          )
          .orderBy(asc(SessionInputTable.admitted_seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (!pending) return false
        return yield* Effect.gen(function* () {
          const input = yield* SessionInput.find(db, pending.id)
          if (!input || input.promotedSeq !== undefined) return false
          if (input.delivery !== "queue" || input.prompt.files?.length || input.prompt.agents?.length) {
            return yield* Effect.die("Legacy loop delivery requires a queued text-only prompt")
          }
          const messageID = MessageID.make(input.id)
          const partID = PartID.make(`prt_loop_${input.id}`)
          const stored = yield* db
            .select()
            .from(MessageTable)
            .where(eq(MessageTable.id, messageID))
            .get()
            .pipe(Effect.orDie)
          // Preserve the first materialization's time and metadata across crash retries.
          // The visible time is promotion time, not admission time: queue inputs must
          // follow the foreground assistant in the legacy timestamp-ordered history.
          if (stored) {
            const saved = Schema.decodeUnknownSync(SessionV1.User)({
              ...stored.data,
              id: stored.id,
              sessionID: stored.session_id,
            })
            if (
              saved.sessionID !== sessionID ||
              saved.format !== undefined ||
              saved.system !== undefined ||
              saved.tools !== undefined ||
              saved.summary !== undefined
            ) {
              return yield* Effect.die(`Conflicting legacy loop message: ${messageID}`)
            }
          } else {
            const previous = yield* sessions
              .findMessage(sessionID, (message) => message.info.role === "user")
              .pipe(Effect.orDie)
            if (Option.isNone(previous) || previous.value.info.role !== "user")
              return yield* Effect.die("Legacy loop has no user context")
            const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
            yield* sessions.updateMessage({
              id: messageID,
              sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: session.agent ?? previous.value.info.agent,
              model: session.model
                ? {
                    providerID: session.model.providerID,
                    modelID: session.model.id,
                    variant: session.model.variant === "default" ? undefined : session.model.variant,
                  }
                : previous.value.info.model,
            })
          }
          const part = yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get().pipe(Effect.orDie)
          const siblings = yield* db
            .select({ id: PartTable.id })
            .from(PartTable)
            .where(eq(PartTable.message_id, messageID))
            .all()
            .pipe(Effect.orDie)
          if (
            siblings.some((row) => row.id !== partID) ||
            (part &&
              (part.session_id !== sessionID ||
                part.message_id !== messageID ||
                !isDeepStrictEqual(part.data, { type: "text", text: input.prompt.text })))
          )
            return yield* Effect.die(`Conflicting legacy loop text: ${messageID}`)
          if (!part)
            yield* sessions.updatePart({ id: partID, messageID, sessionID, type: "text", text: input.prompt.text })
          yield* sessions.touch(sessionID)
          yield* SessionInput.acknowledge(db, events, input)
          return true
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const failedAt = yield* Clock.currentTimeMillis
              yield* loops.recordFailure({
                id: SessionLoop.ID.make(pending.loop),
                messageID: pending.id,
                now: failedAt,
                retryAt: failedAt + Math.min(300000, 1000 * 2 ** Math.min(pending.failureCount, 20)),
                error: Cause.pretty(cause),
              })
              return yield* Effect.failCause(cause)
            }),
          ),
        )
      })
      return Service.of({ next })
    }),
  ),
  deps: [Database.node, Session.node, EventV2Bridge.node, SessionLoop.node],
})
