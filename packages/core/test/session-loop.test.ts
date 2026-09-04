import path from "path"
import { describe, expect, test } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionLoop } from "@opencode-ai/core/session/loop"
import { SessionInputTable, SessionLoopTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionLoop.node])))
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
  it.effect("emits checkpoint counts and completion requests without checkpoint or session content", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      const events = yield* EventV2.Service
      const observed: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type.startsWith("capability.loop.")) observed.push(event)
        }),
      )
      const criterion = "private acceptance criterion"
      const created = yield* loops.create({
        sessionID,
        prompt: "private loop prompt",
        mode: "adaptive",
        checkpoint: { objective: "private objective", acceptanceCriteria: [criterion], nextAction: "inspect" },
        now: 1_000,
      })
      yield* loops.checkpoint({
        sessionID,
        id: created.id,
        checkpoint: { observations: ["private observation"], artifacts: ["/private/artifact"] },
        now: 2_000,
      })
      yield* loops
        .checkpoint({
          sessionID,
          id: created.id,
          checkpoint: {},
          state: "completed",
          reason: "unsupported completion",
          now: 3_000,
        })
        .pipe(Effect.exit)
      yield* loops.checkpoint({
        sessionID,
        id: created.id,
        checkpoint: { verifiedFacts: [{ claim: criterion, evidence: ["artifact:public-ref"] }] },
        state: "completed",
        reason: "verified",
        now: 4_000,
      })
      yield* unsubscribe

      expect(observed.map((event) => event.type)).toEqual([
        "capability.loop.checkpoint.updated",
        "capability.loop.checkpoint.updated",
        "capability.loop.completion.requested",
        "capability.loop.completion.requested",
        "capability.loop.checkpoint.updated",
      ])
      expect(observed.at(-1)?.data).toMatchObject({
        loopID: created.id,
        state: "completed",
        factCount: 1,
        evidenceCount: 1,
        artifactCount: 1,
        blockerCount: 0,
      })
      const serialized = JSON.stringify(observed)
      expect(serialized).not.toContain(sessionID)
      expect(serialized).not.toContain("private objective")
      expect(serialized).not.toContain("private observation")
      expect(serialized).not.toContain("/private/artifact")
    }),
  )

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

  it.effect("claims each due invocation once and reuses its message ID after failure", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      const created = yield* loops.create({
        sessionID,
        prompt: "Check CI",
        mode: "fixed",
        intervalMs: 60_000,
        now: 1_000,
      })

      const [claim] = yield* loops.claimDue({ owner: "one", now: 61_000, leaseMs: 30_000, limit: 10 })
      expect(claim.loop.nextRunAt).toBe(121_000)
      expect(claim.loop.pendingMessageID).toBe(claim.messageID)
      expect(yield* loops.claimDue({ owner: "two", now: 61_000, leaseMs: 30_000, limit: 10 })).toEqual([])

      yield* loops.recordFailure({
        id: created.id,
        messageID: claim.messageID,
        now: 61_001,
        retryAt: 66_001,
        error: "provider unavailable",
      })
      const [retried] = yield* loops.claimDue({ owner: "two", now: 66_001, leaseMs: 30_000, limit: 10 })
      expect(retried.messageID).toBe(claim.messageID)

      yield* loops.markAdmitted({ id: created.id, messageID: claim.messageID, now: 66_002 })
      expect(yield* loops.get({ sessionID, id: created.id })).toMatchObject({
        lastAdmittedAt: 66_002,
        failureCount: 0,
        pendingMessageID: claim.messageID,
      })
    }),
  )

  it.effect("coalesces unpromoted input and clears promoted input", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const loops = yield* SessionLoop.Service
      const created = yield* loops.create({
        sessionID,
        prompt: "Check CI",
        mode: "fixed",
        intervalMs: 60_000,
        now: 1_000,
      })
      const [claim] = yield* loops.claimDue({ owner: "one", now: 61_000, leaseMs: 30_000, limit: 10 })
      yield* db
        .insert(SessionInputTable)
        .values({
          id: claim.messageID,
          session_id: sessionID,
          prompt: { text: "scheduled" },
          delivery: "queue",
          admitted_seq: 1,
          time_created: 61_000,
        })
        .run()
        .pipe(Effect.orDie)
      yield* loops.markAdmitted({ id: created.id, messageID: claim.messageID, now: 61_001 })

      expect(yield* loops.claimDue({ owner: "two", now: 121_000, leaseMs: 30_000, limit: 10 })).toEqual([])
      expect(yield* loops.get({ sessionID, id: created.id })).toMatchObject({
        pendingMessageID: claim.messageID,
        nextRunAt: 181_000,
      })

      yield* db
        .update(SessionInputTable)
        .set({ promoted_seq: 2 })
        .where(eq(SessionInputTable.id, claim.messageID))
        .run()
        .pipe(Effect.orDie)
      yield* loops.reconcilePending(121_001)
      expect((yield* loops.get({ sessionID, id: created.id })).pendingMessageID).toBeUndefined()
    }),
  )

  it.effect("handles adaptive fallback and explicit state transitions", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      const adaptive = yield* loops.create({ sessionID, prompt: "decide", mode: "adaptive", now: 1_000 })
      const [claim] = yield* loops.claimDue({ owner: "one", now: 1_000, leaseMs: 30_000, limit: 10 })
      expect(claim.loop.nextRunAt).toBe(601_000)

      const paused = yield* loops.update({
        sessionID,
        id: adaptive.id,
        state: "paused",
        reason: "waiting for user",
        now: 2_000,
      })
      expect(paused.nextRunAt).toBeUndefined()
      const resumed = yield* loops.update({ sessionID, id: adaptive.id, state: "active", now: 3_000 })
      expect(resumed.nextRunAt).toBe(3_000)
      const completed = yield* loops.update({
        sessionID,
        id: adaptive.id,
        state: "completed",
        reason: "acceptance verified",
        checkpoint: {
          acceptanceCriteria: ["CI is green"],
          verifiedFacts: [{ claim: "CI is green", evidence: ["https://example.com/ci"] }],
        },
        now: 4_000,
      })
      expect(completed).toMatchObject({ state: "completed", reason: "acceptance verified" })

      const fixed = yield* loops.create({
        sessionID,
        prompt: "fixed",
        mode: "fixed",
        intervalMs: 60_000,
        now: 5_000,
      })
      yield* loops.update({ sessionID, id: fixed.id, state: "paused", now: 6_000 })
      expect((yield* loops.update({ sessionID, id: fixed.id, state: "active", now: 7_000 })).nextRunAt).toBe(67_000)
    }),
  )

  it.effect("normalizes checkpoint strings and persists evidence with an adaptive loop", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      const loop = yield* loops.create({ sessionID, prompt: "ship", mode: "adaptive", now: 1_000 })

      yield* loops.checkpoint({
        sessionID,
        id: loop.id,
        checkpoint: {
          objective: "  Ship capability packs  ",
          acceptanceCriteria: ["  tests pass ", "tests pass"],
          verifiedFacts: [
            {
              claim: "  focused suite passed ",
              evidence: [" https://example.com/result ", "https://example.com/result"],
            },
          ],
          observations: ["  recorded ", "recorded"],
          inferences: [{ claim: " stable ", confidence: "high" }],
          assumptions: [" none ", "none"],
          decisions: [{ decision: " ship ", reason: " tests pass " }],
          blockers: [" none ", "none"],
          artifacts: [" /tmp/report ", "/tmp/report"],
          nextAction: "  verify release  ",
        },
        now: 2_000,
      })

      expect(yield* loops.get({ sessionID, id: loop.id })).toMatchObject({
        checkpoint: {
          objective: "Ship capability packs",
          acceptanceCriteria: ["tests pass"],
          verifiedFacts: [{ claim: "focused suite passed", evidence: ["https://example.com/result"] }],
          observations: ["recorded"],
          assumptions: ["none"],
          decisions: [{ decision: "ship", reason: "tests pass" }],
          blockers: ["none"],
          artifacts: ["/tmp/report"],
          nextAction: "verify release",
          updatedAt: 2_000,
        },
      })
    }),
  )

  it.effect("rejects oversized checkpoints and adaptive completion without verified acceptance evidence", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      const loop = yield* loops.create({ sessionID, prompt: "ship", mode: "adaptive", now: 1_000 })

      expect(
        yield* Effect.flip(
          loops.checkpoint({
            sessionID,
            id: loop.id,
            checkpoint: { objective: "x".repeat(4_001) },
            now: 2_000,
          }),
        ),
      ).toMatchObject({ _tag: "SessionLoop.InvalidInput", message: expect.stringContaining("checkpoint") })

      expect(
        yield* Effect.flip(
          loops.checkpoint({ sessionID, id: loop.id, checkpoint: {}, state: "completed", reason: "done", now: 2_000 }),
        ),
      ).toMatchObject({ _tag: "SessionLoop.InvalidInput", message: expect.stringContaining("acceptance") })
    }),
  )

  it.effect("returns a typed diagnostic and omits a corrupt stored checkpoint", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const loops = yield* SessionLoop.Service
      const loop = yield* loops.create({ sessionID, prompt: "ship", mode: "adaptive", now: 1_000 })
      yield* db
        .update(SessionLoopTable)
        .set({ checkpoint_json: "{not json" })
        .where(eq(SessionLoopTable.id, loop.id))
        .run()
        .pipe(Effect.orDie)

      const stored = yield* loops.get({ sessionID, id: loop.id })
      expect(stored.checkpoint).toBeUndefined()
      expect(stored.checkpointDiagnostic).toBeInstanceOf(SessionLoop.CheckpointDiagnostic)
    }),
  )

  it.effect("rejects every blank adaptive completion reason and repeated evidence beyond the total limit", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      const loop = yield* loops.create({ sessionID, prompt: "ship", mode: "adaptive", now: 1_000 })
      const checkpoint = {
        acceptanceCriteria: ["CI is green"],
        verifiedFacts: [{ claim: "CI is green", evidence: ["https://example.com/ci"] }],
      }

      for (const reason of [undefined, null, "", "   "]) {
        expect(
          yield* Effect.flip(
            loops.checkpoint({ sessionID, id: loop.id, checkpoint, state: "completed", reason, now: 2_000 }),
          ),
        ).toMatchObject({ _tag: "SessionLoop.InvalidInput", message: expect.stringContaining("reason") })
      }
      expect(
        yield* Effect.flip(
          loops.checkpoint({
            sessionID,
            id: loop.id,
            checkpoint: {
              verifiedFacts: Array.from({ length: 3 }, () => ({
                claim: "repeated",
                evidence: Array.from({ length: 50 }, () => "https://example.com/a"),
              })),
            },
            now: 2_000,
          }),
        ),
      ).toMatchObject({ _tag: "SessionLoop.InvalidInput", message: expect.stringContaining("100 evidence") })
    }),
  )

  it.effect("omits stored checkpoints with invalid runtime shape and canonicalizes validated storage", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const loops = yield* SessionLoop.Service
      const loop = yield* loops.create({ sessionID, prompt: "ship", mode: "adaptive", now: 1_000 })
      const stored = {
        objective: " Ship ",
        acceptanceCriteria: [],
        verifiedFacts: [],
        observations: [" seen ", "seen"],
        inferences: [{ claim: "likely", confidence: "medium" }],
        assumptions: [],
        decisions: [],
        blockers: [],
        artifacts: [],
        nextAction: " verify ",
        updatedAt: 2_000,
      }
      yield* db
        .update(SessionLoopTable)
        .set({ checkpoint_json: JSON.stringify(stored) })
        .where(eq(SessionLoopTable.id, loop.id))
        .run()
        .pipe(Effect.orDie)

      expect((yield* loops.get({ sessionID, id: loop.id })).checkpoint).toMatchObject({
        objective: "Ship",
        observations: ["seen"],
        nextAction: "verify",
      })

      yield* db
        .update(SessionLoopTable)
        .set({
          checkpoint_json: JSON.stringify({
            ...stored,
            inferences: [{ claim: "likely", confidence: "certain" }],
            unexpected: true,
          }),
        })
        .where(eq(SessionLoopTable.id, loop.id))
        .run()
        .pipe(Effect.orDie)
      const invalid = yield* loops.get({ sessionID, id: loop.id })
      expect(invalid.checkpoint).toBeUndefined()
      expect(invalid.checkpointDiagnostic).toBeInstanceOf(SessionLoop.CheckpointDiagnostic)
    }),
  )

  it.effect("serializes concurrent checkpoint patches and state updates without restoring stale loop state", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      const loop = yield* loops.create({
        sessionID,
        prompt: "ship",
        mode: "adaptive",
        checkpoint: { objective: "Ship" },
        now: 1_000,
      })

      yield* Effect.all(
        [
          loops.checkpoint({ sessionID, id: loop.id, checkpoint: { observations: ["verified"] }, now: 2_000 }),
          loops.checkpoint({ sessionID, id: loop.id, checkpoint: { blockers: ["waiting"] }, now: 2_000 }),
          loops.update({ sessionID, id: loop.id, state: "paused", reason: "waiting", now: 2_001 }),
        ],
        { concurrency: "unbounded" },
      )

      const stored = yield* loops.get({ sessionID, id: loop.id })
      expect(stored).toMatchObject({
        state: "paused",
        reason: "waiting",
        checkpoint: { objective: "Ship", observations: ["verified"], blockers: ["waiting"] },
      })
      expect(stored.nextRunAt).toBeUndefined()
    }),
  )

  it.effect("allows only one concurrent claimant", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      yield* loops.create({ sessionID, prompt: "race", mode: "adaptive", now: 1_000 })
      const claims = yield* Effect.all(
        ["one", "two"].map((owner) => loops.claimDue({ owner, now: 1_000, leaseMs: 30_000, limit: 10 })),
        { concurrency: "unbounded" },
      )
      expect(claims.flat()).toHaveLength(1)
      expect(claims.flat()[0]?.messageID.startsWith("msg_")).toBe(true)
    }),
  )
})

test("SessionLoop checkpoints survive a database and service restart", async () => {
  await using temporary = await tmpdir()
  const filename = path.join(temporary.path, "loops.sqlite")
  const layer = () =>
    AppNodeBuilder.build(LayerNode.group([Database.node, SessionLoop.node]), [
      [Database.node, Database.layerFromPath(filename)],
    ])
  const loop = await Effect.runPromise(
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      return yield* loops.create({
        sessionID,
        prompt: "ship",
        mode: "adaptive",
        checkpoint: { objective: "Ship", observations: ["saved"], nextAction: "verify" },
        now: 1_000,
      })
    }).pipe(Effect.provide(layer()), Effect.scoped),
  )
  const reopened = await Effect.runPromise(
    Effect.gen(function* () {
      const loops = yield* SessionLoop.Service
      return yield* loops.get({ sessionID, id: loop.id })
    }).pipe(Effect.provide(layer()), Effect.scoped),
  )

  expect(reopened.checkpoint).toMatchObject({ objective: "Ship", observations: ["saved"], nextAction: "verify" })
})
