import { describe, expect, test } from "bun:test"
import { CapabilityEvent } from "@opencode-ai/core/capability/event"
import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { CapabilityRuntime } from "@opencode-ai/core/capability/runtime"
import { CapabilityState } from "@opencode-ai/core/capability/state"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { it, testEffect } from "../lib/effect"
import { location } from "../fixture/location"

const recordingEvents = () => {
  const published: Array<{ readonly type: string; readonly data: unknown }> = []
  const events = {
    publish: (definition: EventV2.Definition, data: unknown) =>
      Effect.sync(() => {
        const event = { type: definition.type, data }
        published.push(event)
        return event
      }),
  } as unknown as EventV2.Interface
  return { events, published }
}

const materializationSession = SessionV2.ID.make("ses_private_materialization_sentinel")
let materializationActive = false
const materializationLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, ApplicationTools.node, ToolRegistry.node]),
  [
    [
      CapabilityState.node,
      Layer.mock(CapabilityState.Service, {
        list: () =>
          Effect.succeed(
            materializationActive ? [{ id: "browser", profiles: ["default"], state: "active" as const }] : [],
          ),
      }),
    ],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ],
)
const materializationIt = testEffect(materializationLayer)

const privateLocation = "/private/workspace/location-sentinel"
const privateWorkspaceID = WorkspaceV2.ID.make("wrk_private_location_sentinel")
const locatedIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, Location.node]), [
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location({
            directory: AbsolutePath.make(privateLocation),
            workspaceID: privateWorkspaceID,
          }),
        ),
      ),
    ],
  ]),
)

describe("CapabilityEvent", () => {
  locatedIt.effect("keeps ambient routing private while the event is delivered", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const captured: EventV2.Payload[] = []
      const routes: Array<Location.Ref | undefined> = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type.startsWith("capability.")) {
            captured.push(event)
            routes.push(EventV2.routingLocation(event))
          }
        }),
      )

      yield* CapabilityEvent.publish(events, {
        type: "capability.activation.requested",
        capabilityID: "browser",
      })
      yield* unsubscribe

      expect(captured).toHaveLength(1)
      expect(captured[0]).not.toHaveProperty("location")
      expect(routes).toEqual([
        {
          directory: AbsolutePath.make(privateLocation),
          workspaceID: privateWorkspaceID,
        },
      ])
      const serialized = JSON.stringify(captured)
      expect(serialized).not.toContain(privateLocation)
      expect(serialized).not.toContain("wrk_private_location_sentinel")
    }),
  )

  test("publishes only the allowlisted fields for every lifecycle family", async () => {
    const capture = recordingEvents()
    const sentinel = "never-log-this-secret"
    const tainted = [
      { type: "capability.activation.requested", capabilityID: "browser", token: sentinel },
      {
        type: "capability.activation.succeeded",
        capabilityID: "browser",
        state: "active",
        durationMs: 7,
        runtimeCount: 1,
        authorization: sentinel,
      },
      {
        type: "capability.activation.degraded",
        capabilityID: "documents",
        state: "degraded",
        durationMs: 8,
        runtimeCount: 0,
        environment: { TOKEN: sentinel },
      },
      {
        type: "capability.activation.failed",
        capabilityID: "research",
        state: "failed",
        durationMs: 9,
        runtimeCount: 1,
        diagnosticRef: "runtime-start-failed",
        diagnostic: `https://${sentinel}.invalid/private/path`,
      },
      {
        type: "capability.runtime.started",
        runtimeID: "playwright",
        state: "healthy",
        durationMs: 4,
        referenceCount: 1,
        headers: { authorization: sentinel },
      },
      {
        type: "capability.runtime.reused",
        runtimeID: "playwright",
        state: "healthy",
        referenceCount: 2,
        arguments: [sentinel],
      },
      {
        type: "capability.runtime.stopped",
        runtimeID: "playwright",
        state: "stopped",
        durationMs: 2,
        referenceCount: 0,
        browserStorage: sentinel,
      },
      {
        type: "capability.runtime.crashed",
        runtimeID: "playwright",
        state: "failed",
        referenceCount: 1,
        diagnosticRef: "runtime-exited",
        url: `https://${sentinel}.invalid`,
      },
      { type: "capability.definitions.added", count: 3, fileContents: sentinel },
      { type: "capability.definitions.removed", count: 2, path: `/tmp/${sentinel}` },
      {
        type: "capability.loop.checkpoint.updated",
        loopID: "loop_public",
        state: "active",
        factCount: 2,
        evidenceCount: 3,
        artifactCount: 1,
        blockerCount: 0,
        rawCheckpoint: sentinel,
      },
      {
        type: "capability.loop.completion.requested",
        loopID: "loop_public",
        state: "completed",
        prompt: sentinel,
      },
      {
        type: "capability.startup.measured",
        capabilityID: "browser",
        state: "active",
        durationMs: 11,
        runtimeCount: 1,
        hostname: sentinel,
      },
      {
        type: "capability.schema.estimated",
        state: "active",
        definitionCount: 9,
        baselineBytes: 400,
        baselineTokens: 100,
        activatedBytes: 520,
        activatedTokens: 130,
        deltaBytes: 120,
        deltaTokens: 30,
        sessionID: sentinel,
      },
    ] as const

    for (const input of tainted) {
      await Effect.runPromise(CapabilityEvent.publish(capture.events, input))
    }

    expect(capture.published.map((event) => event.type)).toEqual(tainted.map((event) => event.type))
    const serialized = JSON.stringify(capture.published)
    expect(serialized).not.toContain(sentinel)
    expect(Object.keys(capture.published[0]!.data as object)).toEqual(["capabilityID"])
    expect(capture.published.at(-1)?.data).toEqual({
      state: "active",
      definitionCount: 9,
      baselineBytes: 400,
      baselineTokens: 100,
      activatedBytes: 520,
      activatedTokens: 130,
      deltaBytes: 120,
      deltaTokens: 30,
    })
  })

  test("event publication failure cannot fail the observed operation", async () => {
    const events = {
      publish: () => Effect.die(new Error("subscriber failed with private data")),
    } as unknown as EventV2.Interface

    expect(
      await Effect.runPromise(
        CapabilityEvent.publish(events, {
          type: "capability.activation.requested",
          capabilityID: "browser",
        }).pipe(Effect.andThen(Effect.succeed("operation-result"))),
      ),
    ).toBe("operation-result")
  })

  test("observes successful, degraded, failed, and interrupted activation exits", async () => {
    const capture = recordingEvents()
    const run = <A extends { readonly state: "active" | "degraded" | "failed" | "unsupported" }>(
      id: string,
      operation: Effect.Effect<A, Error>,
    ) => CapabilityEvent.observeActivation(capture.events, { capabilityID: id, runtimeCount: 1 }, operation)

    await Effect.runPromise(run("active-pack", Effect.succeed({ state: "active" as const })))
    await Effect.runPromise(run("degraded-pack", Effect.succeed({ state: "degraded" as const })))
    await Effect.runPromise(run("failed-pack", Effect.succeed({ state: "failed" as const })))
    await Effect.runPromise(run("rejected-pack", Effect.fail(new Error("private rejection"))).pipe(Effect.exit))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const fiber = yield* run(
            "interrupted-pack",
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ).pipe(Effect.forkIn(yield* Effect.scope, { startImmediately: true }))
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )

    const activation = capture.published.filter((event) => event.type.startsWith("capability.activation."))
    expect(activation.map((event) => event.type)).toEqual([
      "capability.activation.requested",
      "capability.activation.succeeded",
      "capability.activation.requested",
      "capability.activation.degraded",
      "capability.activation.requested",
      "capability.activation.failed",
      "capability.activation.requested",
      "capability.activation.failed",
      "capability.activation.requested",
      "capability.activation.failed",
    ])
    expect(
      activation.filter((event) => event.type === "capability.activation.failed").map((event) => event.data),
    ).toMatchObject([
      { capabilityID: "failed-pack", state: "failed", diagnosticRef: "activation-rejected" },
      { capabilityID: "rejected-pack", state: "failed", diagnosticRef: "activation-error" },
      { capabilityID: "interrupted-pack", state: "interrupted", diagnosticRef: "activation-interrupted" },
    ])
    expect(capture.published.filter((event) => event.type === "capability.startup.measured")).toHaveLength(5)
    expect(JSON.stringify(capture.published)).not.toContain("private rejection")
  })

  it.effect("emits shared runtime start, reuse, crash, restart, and stop transitions", () =>
    Effect.gen(function* () {
      const capture = recordingEvents()
      const sentinel = "runtime-private-value"
      const crashed = yield* Deferred.make<void, Error>()
      let starts = 0
      const runtime = yield* CapabilityRuntime.make(
        {
          start: () =>
            Effect.sync(() => {
              starts++
              return {
                value: { tools: [] },
                stop: Effect.void,
                ...(starts === 1 ? { exited: Deferred.await(crashed) } : {}),
              }
            }),
        },
        { idleCloseMs: 1_000, events: capture.events },
      )
      const definition = CapabilityManifest.Runtime.make({
        id: CapabilityManifest.ID.make("playwright"),
        type: "mcp",
        command: ["playwright"],
        tools: [],
        environment: { TOKEN: sentinel },
        optional: false,
        timeoutMs: 15_000,
      })

      const first = yield* runtime.acquire("browser/playwright#opaque", definition)
      const second = yield* runtime.acquire("browser/playwright#opaque", definition)
      yield* Deferred.fail(crashed, new Error(`crashed at https://${sentinel}.invalid/private`))
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* runtime.release(first)
      yield* runtime.release(second)
      yield* TestClock.adjust("1001 millis")

      expect(starts).toBe(2)
      expect(capture.published.map((event) => event.type)).toEqual([
        "capability.runtime.started",
        "capability.runtime.reused",
        "capability.runtime.crashed",
        "capability.runtime.started",
        "capability.runtime.stopped",
      ])
      expect(JSON.stringify(capture.published)).not.toContain(sentinel)
      expect(
        capture.published.every((event) => JSON.stringify(event.data).includes("browser/playwright") === false),
      ).toBe(true)
    }),
  )

  it.effect("emits runtime release when a later required startup rolls activation back", () =>
    Effect.gen(function* () {
      const capture = recordingEvents()
      let stopped = 0
      const runtime = yield* CapabilityRuntime.make(
        {
          start: (_key, definition) =>
            definition.id === "first"
              ? Effect.succeed({
                  value: { tools: [] },
                  stop: Effect.sync(() => {
                    stopped++
                  }),
                })
              : Effect.fail(new Error("private second-runtime failure")),
        },
        { events: capture.events },
      )
      const definition = (id: string) =>
        CapabilityManifest.Runtime.make({
          id: CapabilityManifest.ID.make(id),
          type: "mcp",
          command: [id],
          tools: [],
          optional: false,
          timeoutMs: 15_000,
        })

      const result = yield* runtime.activate([
        { key: "rollback/first", definition: definition("first") },
        { key: "rollback/second", definition: definition("second") },
      ])

      expect(result.state).toBe("failed")
      expect(stopped).toBe(1)
      expect(capture.published.map((event) => event.type)).toEqual([
        "capability.runtime.started",
        "capability.runtime.stopped",
      ])
      expect(JSON.stringify(capture.published)).not.toContain("private second-runtime failure")
    }),
  )

  materializationIt.effect("measures the final filtered schemas and emits only real definition deltas", () =>
    Effect.gen(function* () {
      materializationActive = false
      const events = yield* EventV2.Service
      const registry = yield* ToolRegistry.Service
      const captured: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type.startsWith("capability.")) captured.push(event)
        }),
      )
      const echo = (description: string) =>
        Tool.make({
          description,
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed("ok"),
        })
      yield* registry.register({
        baseline: echo("baseline"),
        browser_playwright_navigate: Tool.withOrigin(echo("private-tool-description"), {
          type: "mcp",
          serverID: "playwright",
          capability: "browser",
          profile: "default",
        }),
      })

      const baseline = yield* registry.materialize(materializationSession)
      materializationActive = true
      const activated = yield* registry.materialize(materializationSession)
      yield* registry.materialize(materializationSession, [
        { action: "browser_playwright_navigate", resource: "*", effect: "deny" },
      ])
      materializationActive = false
      yield* registry.materialize(materializationSession)
      yield* unsubscribe

      expect(baseline.definitions.map((definition) => definition.name)).toEqual(["baseline"])
      expect(activated.definitions.map((definition) => definition.name).toSorted()).toEqual([
        "baseline",
        "browser_playwright_navigate",
      ])
      expect(
        captured.filter((event) => event.type === "capability.definitions.added").map((event) => event.data),
      ).toEqual([{ count: 1 }])
      expect(
        captured.filter((event) => event.type === "capability.definitions.removed").map((event) => event.data),
      ).toEqual([{ count: 1 }])
      const estimates = captured.filter((event) => event.type === "capability.schema.estimated")
      expect(estimates).toHaveLength(4)
      expect(estimates[0]?.data).toMatchObject({ state: "baseline", definitionCount: 1, deltaBytes: 0, deltaTokens: 0 })
      expect(estimates[1]?.data).toMatchObject({ state: "active", definitionCount: 2 })
      expect((estimates[1]?.data as { deltaBytes: number }).deltaBytes).toBeGreaterThan(0)
      expect(estimates[2]?.data).toMatchObject({ state: "baseline", definitionCount: 1, deltaBytes: 0, deltaTokens: 0 })
      const serialized = JSON.stringify(captured)
      expect(serialized).not.toContain(materializationSession)
      expect(serialized).not.toContain("private-tool-description")
    }),
  )

  materializationIt.effect("bounds inactive-session materialization snapshots with deterministic eviction", () =>
    Effect.gen(function* () {
      materializationActive = true
      const events = yield* EventV2.Service
      const registry = yield* ToolRegistry.Service
      const captured: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === "capability.definitions.added") captured.push(event)
        }),
      )
      const echo = Tool.make({
        description: "bounded-snapshot-secret-schema",
        input: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.succeed("ok"),
      })
      yield* registry.register({
        browser_playwright_bounded: Tool.withOrigin(echo, {
          type: "mcp",
          serverID: "playwright",
          capability: "browser",
          profile: "default",
        }),
      })

      const first = SessionV2.ID.make("ses_snapshot_0")
      for (let index = 0; index <= ToolRegistry.MATERIALIZATION_SNAPSHOT_LIMIT; index++) {
        yield* registry.materialize(SessionV2.ID.make(`ses_snapshot_${index}`))
      }
      yield* registry.materialize(first)
      yield* unsubscribe

      expect(captured).toHaveLength(ToolRegistry.MATERIALIZATION_SNAPSHOT_LIMIT + 2)
      expect(JSON.stringify(captured)).not.toContain("bounded-snapshot-secret-schema")
    }),
  )
})
