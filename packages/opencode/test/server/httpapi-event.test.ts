import { afterEach, describe, expect } from "bun:test"
import { Effect, Queue, Schema, Stream } from "effect"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { CapabilityEvent } from "@opencode-ai/core/capability/event"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const PrivateDurableSseEvent = EventV2.define({
  type: "capability.test.private-durable-sse",
  durable: { version: 1, aggregate: "capabilityID" },
  schema: { capabilityID: Schema.String },
})

const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    const value = yield* Queue.take(reader).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    return Schema.decodeUnknownSync(EventData)(JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "")))
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffectShared(httpApiLayer)

describe("event HttpApi", () => {
  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(response.headers["cache-control"]).toBe("no-cache, no-transform")
        expect(response.headers["x-accel-buffering"]).toBe("no")
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Queue.take(reader).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "delivers instance events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        expect(yield* readEvent(reader)).toMatchObject({ type: "session.created" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "routes private capability events to the instance stream without exposing location",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected" })

        yield* Effect.promise(() =>
          AppRuntime.runPromise(
            InstanceStore.Service.use((store) =>
              store.provide(
                { directory },
                EventV2Bridge.Service.use((events) =>
                  CapabilityEvent.publish(events, {
                    type: "capability.activation.requested",
                    capabilityID: "browser",
                  }),
                ),
              ),
            ),
          ),
        )
        const event = yield* readEvent(reader)

        expect(event).toEqual({
          id: expect.any(String),
          type: "capability.activation.requested",
          properties: { capabilityID: "browser" },
        })
        expect(JSON.stringify(event)).not.toContain(directory)

        yield* Effect.promise(() =>
          AppRuntime.runPromise(
            InstanceStore.Service.use((store) =>
              store.provide(
                { directory },
                EventV2Bridge.Service.use((events) =>
                  events.publish(
                    PrivateDurableSseEvent,
                    { capabilityID: "private-durable" },
                    { location: false },
                  ),
                ),
              ),
            ),
          ),
        )
        const durableEvent = yield* readEvent(reader)
        expect(durableEvent).toMatchObject({
          type: PrivateDurableSseEvent.type,
          properties: { capabilityID: "private-durable" },
        })
        expect(JSON.stringify(durableEvent)).not.toContain(directory)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
