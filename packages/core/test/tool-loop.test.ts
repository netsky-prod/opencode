import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CapabilityState } from "@opencode-ai/core/capability/state"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionLoop } from "@opencode-ai/core/session/loop"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { LoopTool } from "@opencode-ai/core/tool/loop"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_loop_tool_test")
const otherSessionID = SessionV2.ID.make("ses_loop_tool_other")
const assertions = new Array<PermissionV2.AssertInput>()
let deny = false

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, SessionLoop.node, ToolRegistry.node, ToolRegistry.toolsNode, LoopTool.node]),
    [
      [CapabilityState.node, Layer.mock(CapabilityState.Service, { list: () => Effect.succeed([]) })],
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const setup = Effect.gen(function* () {
  assertions.length = 0
  deny = false
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

const call = (name: string, input: unknown, currentSessionID = sessionID) => ({
  sessionID: currentSessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})

describe("LoopTool", () => {
  it.effect("registers all loop tools and creates fixed and adaptive loops", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const loops = yield* SessionLoop.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name).sort()).toEqual([
        "loop_create",
        "loop_delete",
        "loop_list",
        "loop_update",
        "loop_wakeup",
      ])

      expect(
        yield* settleTool(
          registry,
          call("loop_create", {
            prompt: "Check CI",
            schedule: { kind: "fixed", every: "10m" },
            reason: "CI may finish",
          }),
        ),
      ).toMatchObject({ result: { type: "text", value: expect.stringContaining("state: active") } })
      yield* settleTool(
        registry,
        call("loop_create", { prompt: "Choose the next step", schedule: { kind: "adaptive" } }),
      )

      const stored = yield* loops.list(sessionID)
      expect(stored.map((loop) => loop.mode).sort()).toEqual(["adaptive", "fixed"])
      expect(stored.find((loop) => loop.mode === "fixed")?.intervalMs).toBe(600_000)
      expect(assertions.map((input) => input.action)).toEqual(["loop", "loop"])
      expect(assertions[0]).toMatchObject({ sessionID, resources: ["new"], save: ["*"] })
    }),
  )

  it.effect("lists only the current session and hides cross-session ownership", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const loops = yield* SessionLoop.Service
      yield* loops.create({ sessionID, prompt: "mine", mode: "adaptive", now: 1_000 })
      const other = yield* loops.create({ sessionID: otherSessionID, prompt: "secret", mode: "adaptive", now: 1_000 })

      const listed = yield* executeTool(registry, call("loop_list", {}))
      expect(listed).toMatchObject({ type: "text", value: expect.stringContaining("mine") })
      expect(JSON.stringify(listed)).not.toContain("secret")
      expect(assertions).toEqual([])

      expect(yield* executeTool(registry, call("loop_update", { id: other.id, state: "paused" }))).toEqual({
        type: "error",
        value: "Unable to update loop",
      })
    }),
  )

  it.effect("pauses, resumes, completes, wakes, and deletes loops", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const loops = yield* SessionLoop.Service
      const loop = yield* loops.create({
        sessionID,
        prompt: "manage",
        mode: "adaptive",
        reason: "original",
        now: 1_000,
      })

      yield* settleTool(registry, call("loop_update", { id: loop.id, state: "paused" }))
      expect((yield* loops.get({ sessionID, id: loop.id })).state).toBe("paused")
      yield* settleTool(registry, call("loop_update", { id: loop.id, state: "active" }))
      expect((yield* loops.get({ sessionID, id: loop.id })).state).toBe("active")
      yield* settleTool(
        registry,
        call("loop_wakeup", { id: loop.id, action: "schedule", in: "10s", reason: "wait for CI" }),
      )
      expect(yield* loops.get({ sessionID, id: loop.id })).toMatchObject({ state: "active", reason: "wait for CI" })
      yield* settleTool(registry, call("loop_wakeup", { id: loop.id, action: "complete", reason: "done" }))
      expect(yield* loops.get({ sessionID, id: loop.id })).toMatchObject({ state: "completed", reason: "done" })

      yield* settleTool(registry, call("loop_delete", { id: loop.id }))
      expect(yield* loops.list(sessionID)).toEqual([])
      expect(assertions.every((input) => input.action === "loop" && input.save?.[0] === "*")).toBe(true)
    }),
  )

  it.effect("does not mutate storage when permission is denied", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const loops = yield* SessionLoop.Service
      const loop = yield* loops.create({ sessionID, prompt: "keep", mode: "adaptive", now: 1_000 })
      deny = true

      expect(yield* executeTool(registry, call("loop_update", { id: loop.id, state: "paused" }))).toEqual({
        type: "error",
        value: "Unable to update loop",
      })
      expect((yield* loops.get({ sessionID, id: loop.id })).state).toBe("active")
      expect(assertions).toMatchObject([{ sessionID, action: "loop", resources: [loop.id], save: ["*"] }])
    }),
  )
})
