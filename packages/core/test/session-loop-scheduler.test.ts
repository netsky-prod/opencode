import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Clock, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionLoop } from "@opencode-ai/core/session/loop"
import { SessionLoopScheduler } from "@opencode-ai/core/session/loop-scheduler"
import { SessionLoopTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

type PromptInput = Parameters<SessionV2.Interface["prompt"]>[0]
const promptCalls = new Array<PromptInput>()
let promptBehavior: (input: PromptInput) => Effect.Effect<unknown, unknown> = () => Effect.succeed({})

const fakeSessions = Layer.succeed(
  SessionV2.Service,
  SessionV2.Service.of({
    prompt: (input: PromptInput) =>
      Effect.sync(() => promptCalls.push(input)).pipe(Effect.andThen(Effect.suspend(() => promptBehavior(input)))),
  } as SessionV2.Interface),
)

function schedulerNode(startBackground: boolean) {
  return makeGlobalNode({
    service: SessionLoopScheduler.Service,
    layer: SessionLoopScheduler.makeLayer({ owner: "scheduler-test", startBackground }),
    deps: [SessionLoop.node, SessionV2.node],
  })
}

const manual = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, SessionLoop.node, schedulerNode(false)]), [
    [SessionV2.node, fakeSessions],
  ]),
)
const background = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, SessionLoop.node, schedulerNode(true)]), [
    [SessionV2.node, fakeSessions],
  ]),
)

const sessionID = SessionV2.ID.make("ses_loop_scheduler")
const setup = Effect.gen(function* () {
  promptCalls.length = 0
  promptBehavior = () => Effect.succeed({})
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "scheduler",
      directory: AbsolutePath.make("/project"),
      title: "scheduler",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  return yield* Clock.currentTimeMillis
})

describe("SessionLoopScheduler", () => {
  manual.effect("admits fixed and adaptive prompts through the queued V2 path", () =>
    Effect.gen(function* () {
      const now = yield* setup
      const loops = yield* SessionLoop.Service
      const scheduler = yield* SessionLoopScheduler.Service
      const fixed = yield* loops.create({
        sessionID,
        prompt: "Check CI",
        mode: "fixed",
        intervalMs: 10_000,
        now,
      })
      const adaptive = yield* loops.create({ sessionID, prompt: "Choose the next step", mode: "adaptive", now })

      yield* scheduler.tick
      expect(promptCalls).toHaveLength(1)
      expect(promptCalls[0]).toMatchObject({ sessionID, delivery: "queue" })
      expect(promptCalls[0]?.id).toStartWith("msg_")
      expect(promptCalls[0]?.prompt.text).toContain("[Scheduled loop")
      expect(promptCalls[0]?.prompt.text).toContain("loop_wakeup")
      yield* loops.update({ sessionID, id: adaptive.id, state: "completed", now })

      yield* TestClock.adjust("10 seconds")
      yield* scheduler.tick
      expect(promptCalls).toHaveLength(2)
      expect(promptCalls[1]?.prompt.text).toContain(fixed.id)
      expect(promptCalls[1]?.prompt.text).toContain("loop_update")
    }),
  )

  manual.effect("retries with the same message ID and caps exponential backoff", () =>
    Effect.gen(function* () {
      const now = yield* setup
      const { db } = yield* Database.Service
      const loops = yield* SessionLoop.Service
      const scheduler = yield* SessionLoopScheduler.Service
      const loop = yield* loops.create({ sessionID, prompt: "retry", mode: "adaptive", now })
      yield* db
        .update(SessionLoopTable)
        .set({ failure_count: 20 })
        .where(eq(SessionLoopTable.id, loop.id))
        .run()
        .pipe(Effect.orDie)
      promptBehavior = () => Effect.fail(new Error("provider unavailable"))

      yield* scheduler.tick
      const firstID = promptCalls[0]?.id
      expect((yield* loops.get({ sessionID, id: loop.id })).nextRunAt).toBe(now + 300_000)

      yield* TestClock.adjust("5 minutes")
      promptBehavior = () => Effect.succeed({})
      yield* scheduler.tick
      expect(promptCalls[1]?.id).toBe(firstID)
    }),
  )

  manual.effect("completes a loop when its target session is unavailable", () =>
    Effect.gen(function* () {
      const now = yield* setup
      const loops = yield* SessionLoop.Service
      const scheduler = yield* SessionLoopScheduler.Service
      const loop = yield* loops.create({ sessionID, prompt: "orphan", mode: "adaptive", now })
      promptBehavior = (input) => Effect.fail(new SessionV2.NotFoundError({ sessionID: input.sessionID }))

      yield* scheduler.tick
      expect(yield* loops.get({ sessionID, id: loop.id })).toMatchObject({
        state: "completed",
        reason: "Session no longer exists",
      })
    }),
  )

  manual.effect("claims at most 32 loops per tick", () =>
    Effect.gen(function* () {
      const now = yield* setup
      const loops = yield* SessionLoop.Service
      const scheduler = yield* SessionLoopScheduler.Service
      yield* Effect.forEach(
        Array.from({ length: 33 }, (_, index) => index),
        (index) => loops.create({ sessionID, prompt: `job ${index}`, mode: "adaptive", now }),
        { discard: true },
      )

      yield* scheduler.tick
      expect(promptCalls).toHaveLength(32)
    }),
  )

  background.effect("runs the scoped background fiber every second", () =>
    Effect.gen(function* () {
      const now = yield* setup
      const loops = yield* SessionLoop.Service
      yield* loops.create({
        sessionID,
        prompt: "background",
        mode: "fixed",
        intervalMs: 10_000,
        now: now - 10_000,
      })

      yield* TestClock.adjust("1 second")
      yield* Effect.yieldNow
      expect(promptCalls).toHaveLength(1)
      expect(promptCalls[0]?.delivery).toBe("queue")
    }),
  )
})
