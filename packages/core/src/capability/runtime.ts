export * as CapabilityRuntime from "./runtime"

import { Cause, Clock, Context, Effect, Exit, Fiber, Result, Scope, Schema } from "effect"
import { LayerNode } from "../effect/layer-node"
import { Node } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { CapabilityManifest } from "./manifest"

const IDLE_CLOSE = 30_000

export type State = "stopped" | "starting" | "healthy" | "degraded" | "failed"

export type Status = {
  readonly state: State
  readonly references: number
  readonly updatedAt: number
  readonly startedAt?: number
  readonly diagnostic?: string
}

export interface Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
  readonly call: (input: unknown) => Effect.Effect<unknown, unknown>
}

export interface Value {
  readonly tools: ReadonlyArray<Tool>
}

export interface Resource {
  readonly value: Value
  readonly stop: Effect.Effect<void>
  /** Completes or fails when the resource exits unexpectedly. */
  readonly exited?: Effect.Effect<void, unknown>
  readonly state?: "healthy" | "degraded"
  readonly diagnostic?: string
}

export interface Adapter {
  readonly start: (key: string, definition: CapabilityManifest.Runtime) => Effect.Effect<Resource, unknown>
}

declare const ReferenceType: unique symbol

export interface Reference {
  readonly key: string
  readonly available: boolean
  readonly value?: Value
  readonly [ReferenceType]: typeof ReferenceType
}

export type ActivationInput = {
  readonly key: string
  readonly definition: CapabilityManifest.Runtime
}

export type Activation =
  | {
      readonly state: "active" | "degraded"
      readonly references: ReadonlyArray<Reference>
    }
  | {
      readonly state: "failed"
      readonly references: readonly []
      readonly diagnostic: string
    }

export class AcquisitionError extends Schema.TaggedErrorClass<AcquisitionError>()(
  "CapabilityRuntime.AcquisitionError",
  {
    key: Schema.String,
    diagnostic: Schema.String,
  },
) {
  override get message() {
    return `Capability runtime unavailable: ${this.key}: ${this.diagnostic}`
  }
}

export interface Interface {
  readonly acquire: (key: string, definition: CapabilityManifest.Runtime) => Effect.Effect<Reference, AcquisitionError>
  readonly release: (reference: Reference) => Effect.Effect<void>
  readonly activate: (definitions: ReadonlyArray<ActivationInput>) => Effect.Effect<Activation>
  readonly status: (key: string) => Effect.Effect<Status>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CapabilityRuntime") {}

export const node = LayerNode.unbound(Service, Node.tags.values.location)

type Entry = {
  definition: CapabilityManifest.Runtime
  fingerprint: string
  state: State
  references: Set<object>
  updatedAt: number
  startedAt?: number
  diagnostic?: string
  resource?: Resource
  close?: Fiber.Fiber<void>
  generation: number
  restarts: number
}

export const make = (
  adapter: Adapter,
  options: { readonly idleCloseMs?: number } = {},
): Effect.Effect<Interface, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const locks = KeyedMutex.makeUnsafe<string>()
    const entries = new Map<string, Entry>()
    const references = new WeakMap<Reference, { readonly key: string; readonly token: object }>()
    const idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE

    const status = Effect.fn("CapabilityRuntime.status")(function* (key: string) {
      const entry = entries.get(key)
      if (!entry) {
        return { state: "stopped", references: 0, updatedAt: yield* Clock.currentTimeMillis } satisfies Status
      }
      return snapshot(entry)
    })

    const monitor = (key: string, entry: Entry, resource: Resource, generation: number): Effect.Effect<void> => {
      if (!resource.exited) return Effect.void
      return resource.exited.pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          locks.withLock(key)(
            Effect.gen(function* () {
              if (entry.resource !== resource || entry.generation !== generation) return
              entry.resource = undefined
              entry.updatedAt = yield* Clock.currentTimeMillis
              entry.diagnostic = redact(exitDiagnostic(exit), entry.definition)
              yield* resource.stop.pipe(Effect.ignore)
              if (entry.references.size === 0) {
                entry.state = "stopped"
                return
              }
              if (entry.restarts >= 1) {
                entry.state = "failed"
                return
              }
              entry.restarts++
              yield* start(key, entry)
            }),
          ),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      )
    }

    const start = (key: string, entry: Entry): Effect.Effect<Resource | undefined> =>
      Effect.gen(function* () {
        entry.state = "starting"
        entry.diagnostic = undefined
        entry.updatedAt = yield* Clock.currentTimeMillis
        const attempt = yield* adapter.start(key, entry.definition).pipe(
          Effect.timeoutOrElse({
            duration: entry.definition.timeoutMs ?? 15_000,
            orElse: () =>
              Effect.fail(new Error(`Runtime startup timed out after ${entry.definition.timeoutMs ?? 15_000}ms`)),
          }),
          Effect.exit,
        )
        entry.updatedAt = yield* Clock.currentTimeMillis
        if (Exit.isFailure(attempt)) {
          entry.state = entry.definition.optional === true ? "degraded" : "failed"
          entry.diagnostic = redact(causeDiagnostic(attempt.cause), entry.definition)
          return undefined
        }

        entry.resource = attempt.value
        entry.state = attempt.value.state ?? "healthy"
        entry.startedAt = entry.updatedAt
        entry.diagnostic = attempt.value.diagnostic ? redact(attempt.value.diagnostic, entry.definition) : undefined
        entry.generation++
        yield* monitor(key, entry, attempt.value, entry.generation)
        return attempt.value
      })

    const close = Effect.fnUntraced(function* (entry: Entry) {
      const resource = entry.resource
      entry.resource = undefined
      entry.close = undefined
      entry.state = "stopped"
      entry.diagnostic = undefined
      entry.restarts = 0
      entry.generation++
      entry.updatedAt = yield* Clock.currentTimeMillis
      if (resource) yield* resource.stop.pipe(Effect.ignore)
    })

    const acquire = Effect.fn("CapabilityRuntime.acquire")(function* (
      key: string,
      definition: CapabilityManifest.Runtime,
    ) {
      return yield* locks.withLock(key)(
        Effect.gen(function* () {
          const fingerprint = definitionFingerprint(definition)
          const current = entries.get(key)
          if (current && current.references.size > 0 && current.fingerprint !== fingerprint) {
            return yield* new AcquisitionError({
              key,
              diagnostic: "Runtime key is already active with a different definition",
            })
          }
          const entry =
            !current || (current.references.size === 0 && current.fingerprint !== fingerprint)
              ? {
                  definition,
                  fingerprint,
                  state: "stopped" as const,
                  references: new Set<object>(),
                  updatedAt: yield* Clock.currentTimeMillis,
                  generation: 0,
                  restarts: 0,
                }
              : current
          if (entry !== current) entries.set(key, entry)

          if (entry.close) {
            yield* Fiber.interrupt(entry.close)
            entry.close = undefined
          }

          const resource =
            entry.resource ??
            (entry.state === "degraded" && entry.definition.optional ? undefined : yield* start(key, entry))
          if (!resource && !definition.optional) {
            return yield* new AcquisitionError({ key, diagnostic: entry.diagnostic ?? "Runtime startup failed" })
          }

          const token = {}
          entry.references.add(token)
          const reference = Object.freeze({
            key,
            get available() {
              return entry.resource !== undefined
            },
            get value() {
              return entry.resource?.value
            },
          }) as Reference
          references.set(reference, { key, token })
          return reference
        }),
      )
    })

    const drop = Effect.fnUntraced(function* (reference: Reference, immediate: boolean) {
      const identity = references.get(reference)
      if (!identity) return
      references.delete(reference)
      yield* locks.withLock(identity.key)(
        Effect.gen(function* () {
          const entry = entries.get(identity.key)
          if (!entry || !entry.references.delete(identity.token) || entry.references.size > 0) return
          if (immediate) return yield* close(entry)
          const generation = entry.generation
          entry.close = yield* Effect.sleep(idleCloseMs).pipe(
            Effect.andThen(
              locks.withLock(identity.key)(
                Effect.gen(function* () {
                  if (entry.references.size > 0 || entry.generation !== generation) return
                  yield* close(entry)
                }),
              ),
            ),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        }),
      )
    })

    const release = Effect.fn("CapabilityRuntime.release")(function* (reference: Reference) {
      yield* drop(reference, false)
    })

    const activate = Effect.fn("CapabilityRuntime.activate")(function* (definitions: ReadonlyArray<ActivationInput>) {
      const acquired: Reference[] = []
      for (const item of definitions) {
        const result = yield* acquire(item.key, item.definition).pipe(Effect.result)
        if (Result.isSuccess(result)) {
          acquired.push(result.success)
          continue
        }
        yield* Effect.forEach(acquired.toReversed(), (reference) => drop(reference, true), { discard: true })
        return {
          state: "failed" as const,
          references: [] as const,
          diagnostic: result.failure.diagnostic,
        }
      }
      return {
        state: acquired.some((reference) => !reference.available || entries.get(reference.key)?.state === "degraded")
          ? ("degraded" as const)
          : ("active" as const),
        references: Object.freeze(acquired),
      }
    })

    yield* Effect.addFinalizer(() =>
      Effect.forEach(entries.values(), (entry) => close(entry), { concurrency: "unbounded", discard: true }),
    )

    return Service.of({ acquire, release, activate, status })
  })

function snapshot(entry: Entry): Status {
  return {
    state: entry.state,
    references: entry.references.size,
    updatedAt: entry.updatedAt,
    ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
    ...(entry.diagnostic === undefined ? {} : { diagnostic: entry.diagnostic }),
  }
}

function definitionFingerprint(definition: CapabilityManifest.Runtime) {
  return JSON.stringify({
    id: definition.id,
    type: definition.type,
    command: definition.command,
    tools: definition.tools,
    environment: definition.environment
      ? Object.fromEntries(
          Object.entries(definition.environment).toSorted(([left], [right]) => left.localeCompare(right)),
        )
      : undefined,
    optional: definition.optional,
    timeoutMs: definition.timeoutMs,
  })
}

function causeDiagnostic(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

function exitDiagnostic(exit: Exit.Exit<void, unknown>) {
  if (Exit.isSuccess(exit)) return "Runtime exited unexpectedly"
  return causeDiagnostic(exit.cause)
}

function redact(message: string, definition: CapabilityManifest.Runtime) {
  return Object.values(definition.environment ?? {})
    .filter((value) => value.length > 0)
    .reduce((text, value) => text.replaceAll(value, "[redacted]"), message)
}
