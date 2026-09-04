import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { AppRuntime, type AppServices } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LocationServiceMap, locationServiceMapLayer } from "@/location-services"
import { InstanceStore } from "@/project/instance-store"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const it = testEffectShared(httpApiLayer)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// Full host location graphs matter: the MCP adapter brings the legacy bridge
// into a fresh location layer while sharing the process-global EventV2 bus.
const contexts = Effect.gen(function* () {
  const parent = yield* Scope.Scope
  const context = yield* Layer.buildWithMemoMap(locationServiceMapLayer, memoMap, parent)
  const map = Context.get(context, LocationServiceMap.Service)
  const entries = []
  for (let index = 0; index < 4; index++) {
    const directory = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
    const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.andThen(map.invalidate(ref))))
    yield* Layer.buildWithMemoMap(map.get(ref), memoMap, scope)
    entries.push({ ref, scope })
  }
  return { map, entries }
})

const capture = Effect.gen(function* () {
  const events: GlobalEvent[] = []
  const listener = (event: GlobalEvent) => events.push(event)
  GlobalBus.on("event", listener)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
  return events
})

function inDirectory<A, E>(directory: string, work: Effect.Effect<A, E, AppServices>) {
  return Effect.promise(() =>
    AppRuntime.runPromise(InstanceStore.Service.use((store) => store.provide({ directory }, work))),
  )
}

describe("global event bridge lifetime", () => {
  it.instance(
    "forwards each delta once across location creation, disposal and recreation",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const session = yield* inDirectory(
          instance.directory,
          Session.Service.use((sessions) => sessions.create({})),
        )
        const locations = yield* contexts
        const received = yield* capture
        const input = {
          sessionID: session.id,
          messageID: MessageID.ascending(),
          partID: PartID.ascending(),
          field: "text",
          delta: "Let me draft",
        }
        const publish = inDirectory(
          instance.directory,
          EventV2Bridge.Service.use((events) => events.publish(MessageV2.Event.PartDelta, input)),
        )

        const first = yield* publish
        const second = yield* publish
        const deltas = received.filter((event) => event.payload.type === "message.part.delta")
        // Identical text in two distinct model chunks must survive; duplicate
        // subscriptions must not turn either chunk into five copies.
        expect(deltas.map((event) => event.payload.properties.delta)).toEqual(["Let me draft", "Let me draft"])
        expect(deltas.map((event) => event.payload.id)).toEqual([first.id, second.id])
        expect(first.id).not.toBe(second.id)
        expect(deltas.map((event) => event.directory)).toEqual([instance.directory, instance.directory])

        const entry = locations.entries[0]
        yield* Scope.close(entry.scope, Exit.void)
        yield* locations.map.invalidate(entry.ref)
        const third = yield* publish
        expect(received.filter((event) => event.payload.id === third.id)).toHaveLength(1)

        const scope = yield* Scope.Scope
        yield* Layer.buildWithMemoMap(locations.map.get(entry.ref), memoMap, scope)
        const fourth = yield* publish
        expect(received.filter((event) => event.payload.id === fourth.id)).toHaveLength(1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15000,
  )

  it.instance(
    "forwards one durable event and one sync envelope after loading multiple locations",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        yield* contexts
        const received = yield* capture
        const session = yield* inDirectory(
          instance.directory,
          Session.Service.use((sessions) => sessions.create({})),
        )
        const created = received.filter(
          (event) => event.payload.type === "session.created" && event.payload.properties.info.id === session.id,
        )
        const synced = received.filter(
          (event) =>
            event.payload.type === "sync" &&
            event.payload.syncEvent.type === "session.created.1" &&
            event.payload.syncEvent.aggregateID === session.id,
        )
        expect(created).toHaveLength(1)
        expect(synced).toHaveLength(1)
        expect(synced[0].payload.syncEvent.id).toBe(created[0].payload.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15000,
  )
})
