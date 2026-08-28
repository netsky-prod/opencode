import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionLoop } from "@opencode-ai/core/session/loop"
import { SessionLoopTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SessionLoop.node])))
const sessionID = SessionV2.ID.make("ses_loop_test")
const otherSessionID = SessionV2.ID.make("ses_loop_other")
const missingSessionID = SessionV2.ID.make("ses_loop_missing")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values(
      [sessionID, otherSessionID].map((id) => ({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: AbsolutePath.make("/project"),
        title: id,
        version: "test",
      })),
    )
    .run()
    .pipe(Effect.orDie)
})

describe("SessionLoop", () => {
  it.effect("creates, owns, updates, lists, and removes durable loops", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service

      const created = yield* loops.create({
        sessionID,
        prompt: "  Check CI  ",
        mode: "fixed",
        intervalMs: 60_000,
        reason: "  CI may finish  ",
        now: 1_000,
      })
      expect(created).toMatchObject({
        sessionID,
        prompt: "Check CI",
        mode: "fixed",
        intervalMs: 60_000,
        state: "active",
        nextRunAt: 61_000,
        reason: "CI may finish",
      })
      expect(yield* loops.list(sessionID)).toEqual([created])
      expect((yield* loops.get({ sessionID, id: created.id })).id).toBe(created.id)

      const updated = yield* loops.update({
        sessionID,
        id: created.id,
        prompt: "Check deployment",
        reason: "new reason",
        now: 2_000,
      })
      expect(updated).toMatchObject({ prompt: "Check deployment", reason: "new reason" })

      expect(yield* Effect.flip(loops.get({ sessionID: otherSessionID, id: created.id }))).toBeInstanceOf(
        SessionLoop.NotFound,
      )
      expect(yield* Effect.flip(loops.remove({ sessionID: otherSessionID, id: created.id }))).toBeInstanceOf(
        SessionLoop.NotFound,
      )
      expect(yield* loops.remove({ sessionID, id: created.id })).toBe(false)
      expect(yield* loops.list(sessionID)).toEqual([])
    }),
  )

  it.effect("creates adaptive loops and orders active loops by next run then ID", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      const late = yield* loops.create({
        sessionID,
        prompt: "late",
        mode: "fixed",
        intervalMs: 120_000,
        now: 1_000,
      })
      const early = yield* loops.create({
        sessionID,
        prompt: "early",
        mode: "fixed",
        intervalMs: 60_000,
        now: 1_000,
      })
      const adaptive = yield* loops.create({ sessionID, prompt: "adapt", mode: "adaptive", now: 1_000 })

      expect(adaptive.nextRunAt).toBe(1_000)
      expect(adaptive.intervalMs).toBeUndefined()
      expect((yield* loops.list(sessionID)).map((loop) => loop.id)).toEqual([adaptive.id, early.id, late.id])
    }),
  )

  it.effect("rejects invalid inputs and missing sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      const invalid = [
        { sessionID, prompt: "", mode: "adaptive" as const, now: 1_000 },
        { sessionID, prompt: "x", mode: "fixed" as const, now: 1_000 },
        { sessionID, prompt: "x", mode: "fixed" as const, intervalMs: 9_000, now: 1_000 },
        { sessionID, prompt: "x", mode: "adaptive" as const, intervalMs: 60_000, now: 1_000 },
      ]
      for (const input of invalid) {
        expect(yield* Effect.flip(loops.create(input))).toBeInstanceOf(SessionLoop.InvalidInput)
      }
      expect(
        yield* Effect.flip(loops.create({ sessionID: missingSessionID, prompt: "x", mode: "adaptive", now: 1_000 })),
      ).toBeInstanceOf(SessionLoop.SessionNotFound)
    }),
  )

  it.effect("cascades loops when their session is deleted", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const loops = yield* SessionLoop.Service
      yield* loops.create({ sessionID, prompt: "cleanup", mode: "adaptive", now: 1_000 })

      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      expect(
        yield* db.select().from(SessionLoopTable).orderBy(asc(SessionLoopTable.id)).all().pipe(Effect.orDie),
      ).toEqual([])
    }),
  )
})
