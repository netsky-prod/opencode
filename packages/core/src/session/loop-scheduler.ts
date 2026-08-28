export * as SessionLoopScheduler from "./loop-scheduler"

import { Cause, Clock, Context, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionV2 } from "../session"
import { SessionLoop } from "./loop"

const DEFAULT_BATCH_SIZE = 32
const DEFAULT_LEASE_MS = 30_000

export interface Interface {
  readonly tick: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLoopScheduler") {}

function wrap(loop: SessionLoop.Info) {
  const control =
    loop.mode === "adaptive"
      ? "Before finishing, call loop_wakeup with schedule, pause, or complete. Without it, fallback is 10 minutes."
      : "When genuinely complete or blocked on the user, call loop_update with state completed."
  return [
    `[Scheduled loop ${loop.id}]`,
    `Mode: ${loop.mode}`,
    loop.reason ? `Reason: ${loop.reason}` : undefined,
    "",
    loop.prompt,
    "",
    control,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

export function makeLayer(
  options: {
    readonly owner?: string
    readonly batchSize?: number
    readonly leaseMs?: number
    readonly startBackground?: boolean
  } = {},
) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const loops = yield* SessionLoop.Service
      const sessions = yield* SessionV2.Service
      const owner = options.owner ?? crypto.randomUUID()
      const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
      const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS

      const tick = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* loops.reconcilePending(now)
        const claims = yield* loops.claimDue({ owner, now, leaseMs, limit: batchSize })
        yield* Effect.forEach(
          claims,
          (claim) =>
            sessions
              .prompt({
                id: claim.messageID,
                sessionID: claim.loop.sessionID,
                prompt: { text: wrap(claim.loop) },
                delivery: "queue",
              })
              .pipe(
                Effect.tap(() => loops.markAdmitted({ id: claim.loop.id, messageID: claim.messageID, now })),
                Effect.asVoid,
                Effect.catchTag("Session.NotFoundError", () =>
                  loops
                    .update({
                      sessionID: claim.loop.sessionID,
                      id: claim.loop.id,
                      state: "completed",
                      reason: "Session no longer exists",
                      now,
                    })
                    .pipe(Effect.asVoid, Effect.ignore),
                ),
                Effect.catchCause((cause) => {
                  const delay = Math.min(300_000, 1_000 * 2 ** Math.min(claim.loop.failureCount, 20))
                  return loops.recordFailure({
                    id: claim.loop.id,
                    messageID: claim.messageID,
                    now,
                    retryAt: now + delay,
                    error: Cause.pretty(cause),
                  })
                }),
              ),
          { concurrency: 4, discard: true },
        )
      }).pipe(Effect.withSpan("SessionLoopScheduler.tick"))

      const service = Service.of({ tick })
      if (options.startBackground !== false) {
        yield* service.tick.pipe(
          Effect.catchCause((cause) => Effect.logError("Loop scheduler tick failed", { cause: Cause.pretty(cause) })),
          Effect.repeat(Schedule.spaced("1 second")),
          Effect.forkScoped({ startImmediately: true }),
        )
      }
      return service
    }),
  )
}

export const node = makeGlobalNode({
  service: Service,
  layer: makeLayer(),
  deps: [SessionLoop.node, SessionV2.node],
})
