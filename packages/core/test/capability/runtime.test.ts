import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { CapabilityRuntime } from "@opencode-ai/core/capability/runtime"
import { it } from "../lib/effect"

const runtimeDefinition = (input: Partial<CapabilityManifest.Runtime> = {}) =>
  CapabilityManifest.Runtime.make({
    id: CapabilityManifest.ID.make("browser"),
    type: "mcp",
    command: ["browser-server"],
    tools: [],
    optional: false,
    timeoutMs: 15_000,
    ...input,
  })

describe("CapabilityRuntime", () => {
  it.effect("deduplicates concurrent acquisition and stops after the final idle release", () =>
    Effect.gen(function* () {
      let starts = 0
      let stops = 0
      const value = Object.freeze({ tools: [] })
      const runtime = yield* CapabilityRuntime.make({
        start: () =>
          Effect.sync(() => {
            starts++
            return {
              value,
              stop: Effect.sync(() => {
                stops++
              }),
            }
          }),
      })

      const [first, second] = yield* Effect.all(
        [
          runtime.acquire("browser/playwright", runtimeDefinition()),
          runtime.acquire("browser/playwright", runtimeDefinition()),
        ],
        { concurrency: "unbounded" },
      )

      expect(starts).toBe(1)
      expect(first.value).toBe(value)
      expect(second.value).toBe(value)
      yield* runtime.release(first)
      expect(stops).toBe(0)
      yield* runtime.release(second)
      yield* TestClock.adjust("29 seconds")
      expect(stops).toBe(0)
      yield* TestClock.adjust("2 seconds")
      expect(stops).toBe(1)
      expect((yield* runtime.status("browser/playwright")).state).toBe("stopped")
    }),
  )

  it.effect("rolls back acquired resources before reporting a required runtime failure", () =>
    Effect.gen(function* () {
      const stopped: string[] = []
      const runtime = yield* CapabilityRuntime.make({
        start: (key) =>
          key.endsWith("/database")
            ? Effect.fail(new Error("database unavailable"))
            : Effect.succeed({
                value: { tools: [] },
                stop: Effect.sync(() => {
                  stopped.push(key)
                }),
              }),
      })

      const result = yield* runtime.activate([
        { key: "research/browser", definition: runtimeDefinition({ id: CapabilityManifest.ID.make("browser") }) },
        { key: "research/database", definition: runtimeDefinition({ id: CapabilityManifest.ID.make("database") }) },
      ])

      expect(result).toMatchObject({ state: "failed", references: [] })
      expect(stopped).toEqual(["research/browser"])
      expect((yield* runtime.status("research/browser")).references).toBe(0)
    }),
  )

  it.effect("keeps an activation usable and degraded when only an optional runtime fails", () =>
    Effect.gen(function* () {
      const runtime = yield* CapabilityRuntime.make({
        start: (key) =>
          key.endsWith("/optional")
            ? Effect.fail(new Error("optional helper unavailable"))
            : Effect.succeed({ value: { tools: [] }, stop: Effect.void }),
      })

      const result = yield* runtime.activate([
        { key: "research/browser", definition: runtimeDefinition({ id: CapabilityManifest.ID.make("browser") }) },
        {
          key: "research/optional",
          definition: runtimeDefinition({ id: CapabilityManifest.ID.make("optional"), optional: true }),
        },
      ])

      expect(result).toMatchObject({ state: "degraded" })
      expect(result.references).toHaveLength(2)
      expect((yield* runtime.status("research/optional")).state).toBe("degraded")
    }),
  )

  it.effect("stops an idle resource before starting a replacement definition for the same key", () =>
    Effect.gen(function* () {
      const events: string[] = []
      const runtime = yield* CapabilityRuntime.make({
        start: (_key, definition) =>
          Effect.sync(() => {
            const command = definition.command[0]!
            events.push(`start:${command}`)
            return {
              value: { tools: [] },
              stop: Effect.sync(() => {
                events.push(`stop:${command}`)
              }),
            }
          }),
      })
      const first = yield* runtime.acquire("browser/playwright", runtimeDefinition({ command: ["first"] }))
      yield* runtime.release(first)

      yield* runtime.acquire("browser/playwright", runtimeDefinition({ command: ["second"] }))

      expect(events).toEqual(["start:first", "stop:first", "start:second"])
    }),
  )

  it.effect("finishes releasing a reference when interrupted while its key is locked", () =>
    Effect.gen(function* () {
      const firstCrash = yield* Deferred.make<void, Error>()
      const restartStarted = yield* Deferred.make<void>()
      const finishRestart = yield* Deferred.make<void>()
      let starts = 0
      const runtime = yield* CapabilityRuntime.make(
        {
          start: () =>
            Effect.gen(function* () {
              starts++
              if (starts === 2) {
                yield* Deferred.succeed(restartStarted, undefined)
                yield* Deferred.await(finishRestart)
              }
              return {
                value: { tools: [] },
                stop: Effect.void,
                ...(starts === 1 ? { exited: Deferred.await(firstCrash) } : {}),
              }
            }),
        },
        { idleCloseMs: 0 },
      )
      const reference = yield* runtime.acquire("browser/playwright", runtimeDefinition())
      yield* Deferred.fail(firstCrash, new Error("crashed"))
      yield* Deferred.await(restartStarted)
      const releasing = yield* runtime.release(reference).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const interrupting = yield* Fiber.interrupt(releasing).pipe(Effect.forkChild)
      yield* Deferred.succeed(finishRestart, undefined)
      yield* Fiber.join(interrupting)

      expect((yield* runtime.status("browser/playwright")).references).toBe(0)
    }),
  )

  it.effect("rolls back acquired references and interrupts an in-progress start when activation is interrupted", () =>
    Effect.gen(function* () {
      const secondStarted = yield* Deferred.make<void>()
      const secondInterrupted = yield* Deferred.make<void>()
      const stopped: string[] = []
      const runtime = yield* CapabilityRuntime.make({
        start: (key) =>
          key.endsWith("/second")
            ? Deferred.succeed(secondStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(secondInterrupted, undefined)),
              )
            : Effect.succeed({
                value: { tools: [] },
                stop: Effect.sync(() => {
                  stopped.push(key)
                }),
              }),
      })
      const activation = yield* runtime
        .activate([
          { key: "browser/first", definition: runtimeDefinition({ id: CapabilityManifest.ID.make("first") }) },
          { key: "browser/second", definition: runtimeDefinition({ id: CapabilityManifest.ID.make("second") }) },
        ])
        .pipe(Effect.forkChild)
      yield* Deferred.await(secondStarted)

      yield* Fiber.interrupt(activation)
      yield* Deferred.await(secondInterrupted)

      expect(stopped).toEqual(["browser/first"])
      expect((yield* runtime.status("browser/first")).references).toBe(0)
    }),
  )

  it.effect("bounds a never-completing stop during failed activation rollback", () =>
    Effect.gen(function* () {
      const runtime = yield* CapabilityRuntime.make({
        start: (key) =>
          key.endsWith("/second")
            ? Effect.fail(new Error("failed"))
            : Effect.succeed({ value: { tools: [] }, stop: Effect.never }),
      })
      const activation = yield* runtime
        .activate([
          {
            key: "browser/first",
            definition: runtimeDefinition({ id: CapabilityManifest.ID.make("first"), timeoutMs: 100 }),
          },
          {
            key: "browser/second",
            definition: runtimeDefinition({ id: CapabilityManifest.ID.make("second"), timeoutMs: 100 }),
          },
        ])
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust("101 millis")

      expect(activation.pollUnsafe()?._tag).toBe("Success")
      expect((yield* runtime.status("browser/first")).state).toBe("stopped")
    }),
  )

  it.effect("bounds startup when interrupted acquisition cleanup never completes", () =>
    Effect.gen(function* () {
      const runtime = yield* CapabilityRuntime.make({
        start: () =>
          Effect.acquireUseRelease(
            Effect.void,
            () => Effect.never,
            () => Effect.never,
          ),
      })
      const acquisition = yield* runtime
        .acquire("browser/playwright", runtimeDefinition({ timeoutMs: 100 }))
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust("101 millis")

      expect(acquisition.pollUnsafe()?._tag).toBe("Failure")
      expect((yield* runtime.status("browser/playwright")).state).toBe("failed")
    }),
  )

  it.effect("propagates degraded health from an acquired runtime", () =>
    Effect.gen(function* () {
      const runtime = yield* CapabilityRuntime.make({
        start: () =>
          Effect.succeed({
            value: { tools: [] },
            stop: Effect.void,
            state: "degraded" as const,
            diagnostic: "limited mode",
          }),
      })

      const result = yield* runtime.activate([{ key: "browser/playwright", definition: runtimeDefinition() }])

      expect(result.state).toBe("degraded")
      expect((yield* runtime.status("browser/playwright")).diagnostic).toBe("limited mode")
    }),
  )

  it.effect("times out startup, redacts diagnostics, and restarts a crashed runtime only once", () =>
    Effect.gen(function* () {
      const secret = "runtime-secret-value"
      const crashes: Deferred.Deferred<void, Error>[] = []
      const restarted = yield* Deferred.make<void>()
      let starts = 0
      const runtime = yield* CapabilityRuntime.make({
        start: () =>
          Effect.gen(function* () {
            starts++
            const crashed = yield* Deferred.make<void, Error>()
            crashes.push(crashed)
            if (starts === 2) yield* Deferred.succeed(restarted, undefined)
            return {
              value: { tools: [] },
              stop: Effect.void,
              exited: Deferred.await(crashed),
            }
          }),
      })
      const definition = runtimeDefinition({ environment: { TOKEN: secret }, timeoutMs: 100 })
      yield* runtime.acquire("browser/playwright", definition)

      yield* Deferred.fail(crashes[0]!, new Error(`connection lost: ${secret}`))
      yield* Deferred.await(restarted)
      expect(starts).toBe(2)

      yield* Deferred.fail(crashes[1]!, new Error(`connection lost again: ${secret}`))
      const status = yield* Effect.gen(function* () {
        while (true) {
          const current = yield* runtime.status("browser/playwright")
          if (current.state === "failed") return current
          yield* Effect.yieldNow
        }
      })
      expect(status.state).toBe("failed")
      expect(JSON.stringify(status)).not.toContain(secret)
      expect(starts).toBe(2)

      const timeout = yield* CapabilityRuntime.make({ start: () => Effect.never })
      const acquisition = yield* timeout
        .acquire("browser/slow", runtimeDefinition({ timeoutMs: 100 }))
        .pipe(Effect.exit, Effect.forkScoped)
      yield* TestClock.adjust("101 millis")
      expect((yield* Fiber.join(acquisition))._tag).toBe("Failure")
      expect((yield* timeout.status("browser/slow")).state).toBe("failed")
    }),
  )
})
