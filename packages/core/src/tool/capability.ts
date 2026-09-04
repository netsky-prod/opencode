export * as CapabilityTool from "./capability"

import { ToolFailure } from "@opencode-ai/llm"
import { Clock, Effect, Exit, Layer, Result, Schema, Scope } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { CapabilityCatalog } from "../capability/catalog"
import { CapabilityManifest } from "../capability/manifest"
import { CapabilityRuntime } from "../capability/runtime"
import { CapabilityState } from "../capability/state"
import { makeLocationNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { SessionSchema } from "../session/schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_SEARCH_RESULTS = 10
const PROBE_TIMEOUT = "15 seconds"

const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))
const Profiles = Schema.Array(CapabilityManifest.ID).check(Schema.isMinLength(1), Schema.isMaxLength(16))

const DependencyHealth = Schema.Struct({
  id: CapabilityManifest.ID,
  state: Schema.Literals(["available", "missing", "optional-missing"]),
  checkedAt: Schema.Number,
  remediation: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
})

const SearchResult = Schema.Struct({
  id: CapabilityManifest.ID,
  description: Schema.String.check(Schema.isMaxLength(1_000)),
  profiles: Schema.Array(
    Schema.Struct({
      id: CapabilityManifest.ID,
      description: Schema.String.check(Schema.isMaxLength(1_000)),
    }),
  ).check(Schema.isMaxLength(32)),
  active: Schema.Boolean,
  compatible: Schema.Boolean,
  dependencies: Schema.Array(DependencyHealth).check(Schema.isMaxLength(32)),
})

const EnableOutput = Schema.Struct({
  id: CapabilityManifest.ID,
  profiles: Profiles,
  state: Schema.Literals(["active", "degraded", "failed", "unsupported"]),
  nextTurn: Schema.Boolean,
  tools: Schema.Array(Schema.String).check(Schema.isMaxLength(256)),
  skills: Schema.Array(CapabilityManifest.ID).check(Schema.isMaxLength(128)),
  dependencies: Schema.Array(DependencyHealth).check(Schema.isMaxLength(32)),
  remediation: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(32)),
})

const CapabilityStatus = Schema.Struct({
  id: CapabilityManifest.ID,
  state: Schema.Literals(["installed", "active", "degraded", "failed", "unsupported", "unavailable"]),
  profiles: Schema.Array(CapabilityManifest.ID).check(Schema.isMaxLength(32)),
  checkedAt: Schema.Number,
  remediation: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(32)),
})

type DependencyHealth = typeof DependencyHealth.Type
type EnableOutput = typeof EnableOutput.Type
type ProfileID = CapabilityManifest.ID

type Held = {
  readonly pack: CapabilityCatalog.Pack
  readonly profiles: ReadonlyArray<ProfileID>
  readonly references: ReadonlyArray<CapabilityRuntime.Reference>
  readonly registrations: ReadonlyArray<string>
}

type SharedRegistration = {
  count: number
  readonly scope: Scope.Closeable
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const catalog = yield* CapabilityCatalog.Service
    const state = yield* CapabilityState.Service
    const runtime = yield* CapabilityRuntime.Service
    const process = yield* AppProcess.Service
    const permission = yield* PermissionV2.Service
    const tools = yield* Tools.Service
    const hooks = yield* ToolRegistry.MaterializationHooks
    const locks = KeyedMutex.makeUnsafe<string>()
    const registrationLock = KeyedMutex.makeUnsafe<string>()
    const held = new Map<string, Held>()
    const shared = new Map<string, SharedRegistration>()
    const failures = new Map<string, { readonly checkedAt: number; readonly remediation: ReadonlyArray<string> }>()

    const probe = (pack: CapabilityCatalog.Pack) =>
      Effect.forEach(
        pack.dependencies ?? [],
        (dependency) =>
          Effect.gen(function* () {
            const checkedAt = yield* Clock.currentTimeMillis
            const [command, ...args] = dependency.check
            if (!command) {
              return {
                id: dependency.id,
                state: dependency.optional ? ("optional-missing" as const) : ("missing" as const),
                checkedAt,
                remediation: remediation(pack.id, dependency.id),
              }
            }
            const result = yield* process
              .run(ChildProcess.make(command, args, { cwd: pack.directory, stdin: "ignore" }), {
                timeout: PROBE_TIMEOUT,
                maxOutputBytes: 0,
                maxErrorBytes: 1_024,
              })
              .pipe(Effect.result)
            if (Result.isSuccess(result) && result.success.exitCode === 0) {
              return { id: dependency.id, state: "available" as const, checkedAt }
            }
            return {
              id: dependency.id,
              state: dependency.optional ? ("optional-missing" as const) : ("missing" as const),
              checkedAt,
              remediation: remediation(pack.id, dependency.id),
            }
          }),
        { concurrency: "unbounded" },
      )

    const releaseRegistrationsLocked = (keys: ReadonlyArray<string>) =>
      Effect.forEach(
        keys.toReversed(),
        (key) =>
          Effect.gen(function* () {
            const entry = shared.get(key)
            if (!entry) return
            entry.count--
            if (entry.count > 0) return
            shared.delete(key)
            yield* Scope.close(entry.scope, Exit.void)
          }),
        { discard: true },
      )

    const releaseRegistrations = (keys: ReadonlyArray<string>) =>
      registrationLock.withLock("registrations")(releaseRegistrationsLocked(keys))

    const release = (value: Held) =>
      releaseRegistrations(value.registrations).pipe(
        Effect.andThen(
          Effect.forEach(value.references.toReversed(), (reference) => runtime.release(reference), {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
      )

    const register = (
      pack: CapabilityCatalog.Pack,
      profiles: ReadonlyArray<ProfileID>,
      references: ReadonlyArray<CapabilityRuntime.Reference>,
    ) =>
      registrationLock.withLock("registrations")(
        Effect.gen(function* () {
          const added: string[] = []
          const rollback = Effect.suspend(() => releaseRegistrationsLocked(added))
          return yield* Effect.gen(function* () {
            for (const profileID of profiles) {
              const profile = pack.profiles[profileID]
              if (!profile) continue
              for (const runtimeID of profile.runtimes) {
                const key = registrationKey(pack.id, profileID, runtimeID)
                const existing = shared.get(key)
                if (existing) {
                  existing.count++
                  added.push(key)
                  continue
                }
                const reference = references.find((item) => item.key === runtimeKey(pack.id, runtimeID))
                if (!reference?.available || !reference.value) continue
                const scope = yield* Scope.make()
                const registered = Object.fromEntries(
                  reference.value.tools.map((definition) => [
                    definition.name,
                    Tool.withOrigin(
                      Tool.makeDynamic({
                        description: definition.description,
                        inputSchema: definition.inputSchema,
                        execute: (input, context) => {
                          const current = reference.value?.tools.find((item) => item.name === definition.name)
                          if (!reference.available || !current) {
                            return Effect.fail(
                              new ToolFailure({ message: `Capability runtime unavailable: ${pack.id}/${runtimeID}` }),
                            )
                          }
                          return permission
                            .assert({
                              action: definition.name,
                              resources: ["*"],
                              save: ["*"],
                              sessionID: context.sessionID,
                              agent: context.agent,
                              source: {
                                type: "tool",
                                messageID: context.assistantMessageID,
                                callID: context.toolCallID,
                              },
                            })
                            .pipe(
                              Effect.mapError(
                                () => new ToolFailure({ message: `Permission denied: ${definition.name}` }),
                              ),
                              Effect.andThen(
                                current.call(input).pipe(
                                  Effect.mapError(
                                    () =>
                                      new ToolFailure({
                                        message: `Capability tool invocation failed: ${definition.name}`,
                                      }),
                                  ),
                                ),
                              ),
                            )
                        },
                        toStructuredOutput: structuredOutput,
                        toModelOutput: modelOutput,
                      }),
                      { type: "mcp", serverID: runtimeID, capability: pack.id, profile: profileID },
                    ),
                  ]),
                )
                const registration = yield* tools.register(registered).pipe(Scope.provide(scope), Effect.exit)
                if (Exit.isFailure(registration)) {
                  yield* Scope.close(scope, Exit.void)
                  return yield* Effect.failCause(registration.cause)
                }
                shared.set(key, { count: 1, scope })
                added.push(key)
              }
            }
            return added
          }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? rollback : Effect.void)))
        }),
      )

    const activate = (
      sessionID: SessionSchema.ID,
      pack: CapabilityCatalog.Pack,
      profiles: ReadonlyArray<ProfileID>,
      dependencies: ReadonlyArray<DependencyHealth>,
      persist: boolean,
    ): Effect.Effect<EnableOutput, ToolFailure> =>
      locks.withLock(activationKey(sessionID, pack.id))(
        Effect.gen(function* () {
          const previous = held.get(activationKey(sessionID, pack.id))
          if (!compatible(pack)) {
            const output = failedOutput(pack, profiles, dependencies, "unsupported")
            failures.set(activationKey(sessionID, pack.id), {
              checkedAt: yield* Clock.currentTimeMillis,
              remediation: output.remediation,
            })
            return output
          }
          const missing = dependencies.filter((dependency) => dependency.state === "missing")
          if (missing.length > 0) {
            const output = failedOutput(pack, profiles, dependencies, "failed")
            failures.set(activationKey(sessionID, pack.id), {
              checkedAt: Math.max(...missing.map((dependency) => dependency.checkedAt)),
              remediation: output.remediation,
            })
            return output
          }
          const definitions = selectedRuntimes(pack, profiles)
          const result = yield* runtime.activate(
            definitions.map((definition) => ({ key: runtimeKey(pack.id, definition.id), definition })),
          )
          if (result.state === "failed") {
            const output = failedOutput(pack, profiles, dependencies, "failed")
            failures.set(activationKey(sessionID, pack.id), {
              checkedAt: yield* Clock.currentTimeMillis,
              remediation: output.remediation,
            })
            return output
          }

          const registrations = yield* register(pack, profiles, result.references).pipe(
            Effect.mapError(() => new ToolFailure({ message: `Capability tools could not be registered: ${pack.id}` })),
          )
          const next: Held = { pack, profiles, references: result.references, registrations }
          const activationState =
            result.state === "degraded" || dependencies.some((dependency) => dependency.state === "optional-missing")
              ? ("degraded" as const)
              : ("active" as const)
          yield* Effect.gen(function* () {
            if (persist) {
              yield* state
                .enable({ sessionID, id: pack.id, profiles, state: activationState })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
            }
            held.set(activationKey(sessionID, pack.id), next)
            failures.delete(activationKey(sessionID, pack.id))
            if (previous) yield* release(previous)
          }).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) ? release(next) : Effect.void)),
            Effect.uninterruptible,
          )

          return {
            id: pack.id,
            profiles,
            state: activationState,
            nextTurn: true,
            tools: result.references
              .flatMap((reference) => reference.value?.tools.map((tool) => tool.name) ?? [])
              .toSorted(),
            skills: selectedSkills(pack, profiles),
            dependencies,
            remediation: dependencies.flatMap((dependency) => dependency.remediation ?? []),
          }
        }),
      )

    const ensure = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        const activations = yield* state.list(sessionID)
        const active = new Set(activations.map((item) => activationKey(sessionID, item.id)))
        const stale = [...held.entries()].filter(([key]) => key.startsWith(`${sessionID}\u0000`) && !active.has(key))
        yield* Effect.forEach(
          stale,
          ([key, value]) =>
            release(value).pipe(Effect.andThen(Effect.sync(() => held.delete(key))), Effect.uninterruptible),
          { discard: true },
        )
        const outcomes = yield* Effect.forEach(
          activations,
          (item) =>
            Effect.gen(function* () {
              const key = activationKey(sessionID, item.id)
              const current = held.get(key)
              if (current && sameProfiles(current.profiles, item.profiles)) {
                const unavailableRequired = selectedRuntimes(current.pack, current.profiles)
                  .filter((definition) => !definition.optional)
                  .some(
                    (definition) =>
                      !current.references.find(
                        (reference) => reference.key === runtimeKey(current.pack.id, definition.id),
                      )?.available,
                  )
                if (!unavailableRequired) return undefined
              }
              const pack = yield* catalog.get(item.id)
              if (!pack) return item.id
              const profiles = validProfiles(pack, item.profiles)
              if (!profiles) return item.id
              const dependencies = compatible(pack) ? yield* probe(pack) : []
              const output = yield* activate(sessionID, pack, profiles, dependencies, false).pipe(Effect.result)
              return Result.isSuccess(output) && output.success.nextTurn ? undefined : item.id
            }),
          { concurrency: "unbounded" },
        )
        return new Set(outcomes.filter((id): id is string => id !== undefined))
      })

    yield* hooks.register(ensure)
    yield* tools
      .register({
        capability_search: Tool.make({
          description: "Search installed capability packs for a missing ability. Returns at most ten ranked summaries.",
          input: Schema.Struct({ query: ShortText }),
          output: Schema.Struct({
            capabilities: Schema.Array(SearchResult).check(Schema.isMaxLength(MAX_SEARCH_RESULTS)),
          }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const active = new Set((yield* state.list(context.sessionID)).map((item) => item.id))
              const matches = (yield* catalog.search(input.query, active)).slice(0, MAX_SEARCH_RESULTS)
              return {
                capabilities: yield* Effect.forEach(matches, (pack) =>
                  probe(pack).pipe(
                    Effect.map((dependencies) => ({
                      id: pack.id,
                      description: pack.description,
                      profiles: Object.entries(pack.profiles).map(([id, profile]) => ({
                        id: CapabilityManifest.ID.make(id),
                        description: profile.description,
                      })),
                      active: active.has(pack.id),
                      compatible: compatible(pack),
                      dependencies,
                    })),
                  ),
                ),
              }
            }),
        }),
        capability_enable: Tool.make({
          description: "Enable one installed capability pack for this session. New tools and skills appear next turn.",
          input: Schema.Struct({
            id: CapabilityManifest.ID,
            profiles: Profiles.pipe(
              Schema.optional,
              Schema.withDecodingDefault(Effect.succeed([CapabilityManifest.ID.make("default")])),
            ),
          }),
          output: EnableOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              const pack = yield* catalog.get(input.id)
              if (!pack) return yield* new ToolFailure({ message: `Capability manifest not found: ${input.id}` })
              const profiles = validProfiles(pack, input.profiles ?? [CapabilityManifest.ID.make("default")])
              if (!profiles) {
                const missing = input.profiles?.find((profile) => !Object.hasOwn(pack.profiles, profile)) ?? "default"
                return yield* new ToolFailure({ message: `Capability profile not found: ${input.id}/${missing}` })
              }
              const dependencies = compatible(pack) ? yield* probe(pack) : []
              return yield* activate(context.sessionID, pack, profiles, dependencies, true)
            }),
        }),
        capability_disable: Tool.make({
          description: "Disable one capability pack for this session and release its runtime references.",
          input: Schema.Struct({ id: CapabilityManifest.ID }),
          output: Schema.Struct({
            id: CapabilityManifest.ID,
            state: Schema.Literal("disabled"),
            nextTurn: Schema.Boolean,
          }),
          execute: (input, context) =>
            locks.withLock(activationKey(context.sessionID, input.id))(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* state.disable({ sessionID: context.sessionID, id: input.id })
                  const key = activationKey(context.sessionID, input.id)
                  const current = held.get(key)
                  held.delete(key)
                  failures.delete(key)
                  if (current) yield* release(current)
                  return { id: input.id, state: "disabled" as const, nextTurn: true }
                }),
              ),
            ),
        }),
        capability_status: Tool.make({
          description:
            "Report installed and active capability health with concise remediation and no raw process logs.",
          input: Schema.Struct({ id: CapabilityManifest.ID.pipe(Schema.optional) }),
          output: Schema.Struct({ capabilities: Schema.Array(CapabilityStatus).check(Schema.isMaxLength(256)) }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const installed = (yield* catalog.list()).filter((pack) => input.id === undefined || pack.id === input.id)
              const activations = yield* state.status(context.sessionID)
              const active = new Map(activations.map((item) => [item.id, item]))
              const statuses = yield* Effect.forEach(installed, (pack) =>
                Effect.gen(function* () {
                  const activation = active.get(pack.id)
                  const dependencies = yield* probe(pack)
                  const runtimeStatuses = yield* Effect.forEach(
                    selectedRuntimes(pack, activation ? (validProfiles(pack, activation.profiles) ?? []) : []),
                    (definition) => runtime.status(runtimeKey(pack.id, definition.id)),
                  )
                  const remembered = failures.get(activationKey(context.sessionID, pack.id))
                  const checkedAt = Math.max(
                    remembered?.checkedAt ?? 0,
                    ...dependencies.map((dependency) => dependency.checkedAt),
                    ...runtimeStatuses.map((item) => item.updatedAt),
                  )
                  const missing = dependencies.filter((dependency) => dependency.state !== "available")
                  const failed = runtimeStatuses.some((item) => item.state === "failed") || remembered !== undefined
                  const degraded =
                    activation?.state === "degraded" ||
                    runtimeStatuses.some((item) => item.state === "degraded") ||
                    missing.some((item) => item.state === "optional-missing")
                  const currentState = !compatible(pack)
                    ? ("unsupported" as const)
                    : activation
                      ? failed
                        ? ("failed" as const)
                        : degraded
                          ? ("degraded" as const)
                          : ("active" as const)
                      : failed
                        ? ("failed" as const)
                        : ("installed" as const)
                  const remediation = [
                    ...(remembered?.remediation ?? []),
                    ...missing.flatMap((dependency) => dependency.remediation ?? []),
                    ...(runtimeStatuses.some((item) => item.state === "failed")
                      ? [
                          `Retry capability_enable for ${pack.id}; if it still fails, verify the runtime command and credentials.`,
                        ]
                      : []),
                    ...(!compatible(pack)
                      ? [`Use ${pack.id} on one of its supported platforms: ${pack.platforms.join(", ")}.`]
                      : []),
                  ]
                  return {
                    id: pack.id,
                    state: currentState,
                    profiles: (activation?.profiles ?? []).map((profile) => CapabilityManifest.ID.make(profile)),
                    checkedAt: checkedAt || (yield* Clock.currentTimeMillis),
                    remediation: [...new Set(remediation)],
                  }
                }),
              )
              const unavailable = activations
                .filter((activation) => !installed.some((pack) => pack.id === activation.id))
                .filter((activation) => input.id === undefined || activation.id === input.id)
                .map((activation) => ({
                  id: CapabilityManifest.ID.make(activation.id),
                  state: "unavailable" as const,
                  profiles: activation.profiles.map((profile) => CapabilityManifest.ID.make(profile)),
                  checkedAt: 0,
                  remediation: [
                    `Restore the installed manifest for ${activation.id}, or disable the stale activation.`,
                  ],
                }))
              return {
                capabilities: [...statuses, ...unavailable].toSorted((left, right) => left.id.localeCompare(right.id)),
              }
            }),
        }),
      })
      .pipe(Effect.orDie)

    yield* Effect.addFinalizer(() =>
      Effect.forEach(held.values(), release, { concurrency: "unbounded", discard: true }),
    )
  }),
)

export const node = makeLocationNode({
  name: "tool/capability",
  layer,
  deps: [
    ToolRegistry.node,
    CapabilityCatalog.node,
    CapabilityState.node,
    CapabilityRuntime.node,
    AppProcess.node,
    PermissionV2.node,
  ],
})

function activationKey(sessionID: SessionSchema.ID, id: string) {
  return `${sessionID}\u0000${id}`
}

function runtimeKey(pack: string, runtime: string) {
  return `${pack}/${runtime}`
}

function registrationKey(pack: string, profile: string, runtime: string) {
  return `${pack}\u0000${profile}\u0000${runtime}`
}

function compatible(pack: CapabilityCatalog.Pack) {
  if (process.platform !== "darwin" && process.platform !== "linux") return false
  return pack.platforms.includes(process.platform)
}

function validProfiles(
  pack: CapabilityCatalog.Pack,
  profiles: ReadonlyArray<string>,
): ReadonlyArray<ProfileID> | undefined {
  const selected = [...new Set(profiles)].toSorted().map((profile) => CapabilityManifest.ID.make(profile))
  return selected.every((profile) => Object.hasOwn(pack.profiles, profile)) ? selected : undefined
}

function selectedRuntimes(pack: CapabilityCatalog.Pack, profiles: ReadonlyArray<ProfileID>) {
  const selected = new Set(profiles.flatMap((profile) => pack.profiles[profile]?.runtimes ?? []))
  return pack.runtimes.filter((runtime) => selected.has(runtime.id))
}

function selectedSkills(pack: CapabilityCatalog.Pack, profiles: ReadonlyArray<ProfileID>) {
  const selected = new Set(profiles.flatMap((profile) => pack.profiles[profile]?.skills ?? []))
  return pack.skills
    .filter((skill) => selected.has(skill.name))
    .map((skill) => skill.name)
    .toSorted()
}

function sameProfiles(left: ReadonlyArray<ProfileID>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((profile, index) => profile === [...right].toSorted()[index])
}

function remediation(pack: string, dependency: string) {
  return `Install or configure ${dependency}, then retry capability_enable for ${pack}.`
}

function failedOutput(
  pack: CapabilityCatalog.Pack,
  profiles: ReadonlyArray<ProfileID>,
  dependencies: ReadonlyArray<DependencyHealth>,
  state: "failed" | "unsupported",
): EnableOutput {
  return {
    id: pack.id,
    profiles,
    state,
    nextTurn: false,
    tools: [],
    skills: [],
    dependencies,
    remediation:
      state === "unsupported"
        ? [`Use ${pack.id} on one of its supported platforms: ${pack.platforms.join(", ")}.`]
        : [
            ...dependencies.flatMap((dependency) => dependency.remediation ?? []),
            `Retry capability_enable for ${pack.id} after resolving its required runtime health.`,
          ],
  }
}

function structuredOutput(output: unknown) {
  if (!output || typeof output !== "object" || !("structuredContent" in output)) return output
  return (output as { readonly structuredContent?: unknown }).structuredContent ?? output
}

function modelOutput(output: unknown): ReadonlyArray<Tool.Content> {
  if (!output || typeof output !== "object" || !("content" in output)) return []
  const content = (output as { readonly content?: unknown }).content
  if (!Array.isArray(content)) return []
  return content.flatMap((item): ReadonlyArray<Tool.Content> => {
    if (!item || typeof item !== "object" || !("type" in item)) return []
    if (item.type === "text" && "text" in item && typeof item.text === "string") {
      return [{ type: "text", text: item.text }]
    }
    if (
      (item.type === "image" || item.type === "audio") &&
      "data" in item &&
      typeof item.data === "string" &&
      "mimeType" in item &&
      typeof item.mimeType === "string"
    ) {
      return [{ type: "file", data: item.data, mime: item.mimeType }]
    }
    return []
  })
}
