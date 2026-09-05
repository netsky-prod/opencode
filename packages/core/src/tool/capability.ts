export * as CapabilityTool from "./capability"

import { ToolFailure } from "@opencode-ai/llm"
import { Clock, Context, Effect, Exit, Layer, Result, Schema, Scope } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AgentV2 } from "../agent"
import { CapabilityCatalog } from "../capability/catalog"
import { CapabilityEvent } from "../capability/event"
import { CapabilityManifest } from "../capability/manifest"
import { CapabilityRuntime } from "../capability/runtime"
import { CapabilityState } from "../capability/state"
import { makeLocationNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventV2 } from "../event"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { Hash } from "../util/hash"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_SEARCH_RESULTS = 10
const PROBE_TIMEOUT = "15 seconds"
const MAX_PERMISSION_RESOURCES = 32
const MAX_PERMISSION_RESOURCE_LENGTH = 2_000
const MAX_PERMISSION_INPUT_NODES = 256

export class PermissionResourceOverflow extends Schema.TaggedErrorClass<PermissionResourceOverflow>()(
  "CapabilityTool.PermissionResourceOverflow",
  {},
) {
  override get message() {
    return "Capability permission resources exceed the safe limit"
  }
}

const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))
const Profiles = Schema.Array(CapabilityManifest.ID).check(Schema.isMinLength(1), Schema.isMaxLength(16))
const RequestedProfiles = Schema.Array(CapabilityManifest.ID).check(Schema.isMaxLength(16))

const DependencyHealth = Schema.Struct({
  id: CapabilityManifest.ID,
  state: Schema.Literals(["available", "missing", "optional-missing"]),
  checkedAt: Schema.Number,
  remediation: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
})

const ProfileHealth = Schema.Struct({
  state: Schema.Literals(["healthy", "degraded", "failed", "unsupported"]),
  checkedAt: Schema.Number,
  dependencies: Schema.Array(DependencyHealth).check(Schema.isMaxLength(32)),
  remediation: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(32)),
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

export const EnableOutput = Schema.Struct({
  id: CapabilityManifest.ID,
  profiles: Profiles,
  state: Schema.Literals(["active", "degraded", "failed", "unsupported"]),
  nextTurn: Schema.Boolean,
  tools: Schema.Array(Schema.String).check(Schema.isMaxLength(256)),
  skills: Schema.Array(CapabilityManifest.ID).check(Schema.isMaxLength(128)),
  availableTools: Schema.Array(Schema.String).check(Schema.isMaxLength(256)),
  availableSkills: Schema.Array(CapabilityManifest.ID).check(Schema.isMaxLength(128)),
  permissionFiltered: Schema.Boolean,
  dependencies: Schema.Array(DependencyHealth).check(Schema.isMaxLength(32)),
  remediation: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(32)),
})

export const CapabilityStatus = Schema.Struct({
  id: CapabilityManifest.ID,
  state: Schema.Literals(["installed", "active", "degraded", "failed", "unsupported", "unavailable"]),
  profiles: Schema.Array(CapabilityManifest.ID).check(Schema.isMaxLength(32)),
  checkedAt: Schema.Number,
  profileStatus: Schema.Record(CapabilityManifest.ID, ProfileHealth),
  remediation: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(32)),
})

type DependencyHealth = typeof DependencyHealth.Type
type ProfileHealth = typeof ProfileHealth.Type
type EnableOutput = typeof EnableOutput.Type
type ProfileID = CapabilityManifest.ID

type Held = {
  readonly pack: CapabilityCatalog.Pack
  readonly fingerprint: string
  readonly profiles: ReadonlyArray<ProfileID>
  readonly references: ReadonlyArray<CapabilityRuntime.Reference>
  readonly registrations: ReadonlyArray<string>
}

type SharedRegistration = {
  count: number
  readonly scope: Scope.Closeable
}

type EnableInput = {
  readonly id: CapabilityManifest.ID
  readonly profile?: CapabilityManifest.ID
  readonly profiles?: ReadonlyArray<CapabilityManifest.ID>
}
type DisableInput = { readonly id: CapabilityManifest.ID }
type StatusInput = { readonly id?: CapabilityManifest.ID }
type ManagementContext = { readonly sessionID: SessionSchema.ID; readonly agent?: AgentV2.ID }
type StatusContext = { readonly sessionID?: SessionSchema.ID }
export interface Interface {
  readonly refresh: (reference: string) => Effect.Effect<void>
  readonly enable: (input: EnableInput & ManagementContext) => Effect.Effect<EnableOutput, ToolFailure>
  readonly disable: (
    input: DisableInput & ManagementContext,
  ) => Effect.Effect<{ id: CapabilityManifest.ID; state: "disabled"; nextTurn: boolean }>
  readonly status: (
    sessionID?: SessionSchema.ID,
  ) => Effect.Effect<{ capabilities: ReadonlyArray<typeof CapabilityStatus.Type> }>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/CapabilityManagement") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* CapabilityCatalog.Service
    const eventBus = yield* EventV2.Service
    const state = yield* CapabilityState.Service
    const runtime = yield* CapabilityRuntime.Service
    const process = yield* AppProcess.Service
    const permission = yield* PermissionV2.Service
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const tools = yield* Tools.Service
    const hooks = yield* ToolRegistry.MaterializationHooks
    const locks = KeyedMutex.makeUnsafe<string>()
    const registrationLock = KeyedMutex.makeUnsafe<string>()
    const held = new Map<string, Held>()
    const shared = new Map<string, SharedRegistration>()
    const failures = new Map<string, { readonly checkedAt: number; readonly remediation: ReadonlyArray<string> }>()
    const referenceVersions = new Map<string, number>()
    const manifestFingerprint = (pack: CapabilityCatalog.Pack) =>
      Hash.sha256(
        JSON.stringify([
          originalManifestFingerprint(pack),
          pack.runtimes.map((runtime) => (runtime.mcp ? (referenceVersions.get(runtime.mcp) ?? 0) : 0)),
        ]),
      )

    const authorize = (
      context: Tool.Context,
      action: string,
      resources: ReadonlyArray<string>,
      save = resources.filter((resource) => resource !== "*"),
    ) =>
      (context.permission ?? permission)
        .assert({
          action,
          resources,
          ...(save.length > 0 ? { save } : {}),
          sessionID: context.sessionID,
          agent: context.agent,
          source: {
            type: "tool",
            messageID: context.assistantMessageID,
            callID: context.toolCallID,
          },
        })
        .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${action}` })))

    const probe = (pack: CapabilityCatalog.Pack, profiles: ReadonlyArray<ProfileID> = compatibleProfiles(pack)) =>
      Effect.forEach(
        selectedDependencies(pack, profiles),
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
              .run(
                ChildProcess.make(command, args, {
                  cwd: pack.source === "builtin" ? globalThis.process.cwd() : pack.directory,
                  stdin: "ignore",
                }),
                {
                  timeout: PROBE_TIMEOUT,
                  maxOutputBytes: 0,
                  maxErrorBytes: 1_024,
                },
              )
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

    const releaseReferences = (references: ReadonlyArray<CapabilityRuntime.Reference>) =>
      Effect.forEach(references.toReversed(), (reference) => runtime.release(reference), {
        concurrency: "unbounded",
        discard: true,
      })

    const release = (value: Held) =>
      releaseRegistrations(value.registrations).pipe(Effect.ensuring(releaseReferences(value.references)))

    const dropHeld = (key: string, expected: Held) =>
      Effect.gen(function* () {
        if (held.get(key) !== expected) return false
        held.delete(key)
        yield* release(expected)
        return true
      })

    const register = (
      pack: CapabilityCatalog.Pack,
      profiles: ReadonlyArray<ProfileID>,
      references: ReadonlyArray<CapabilityRuntime.Reference>,
    ) =>
      registrationLock.withLock("registrations")(
        Effect.gen(function* () {
          const fingerprint = manifestFingerprint(pack)
          const added: string[] = []
          const rollback = Effect.suspend(() => releaseRegistrationsLocked(added))
          return yield* Effect.gen(function* () {
            for (const profileID of profiles) {
              const profile = pack.profiles[profileID]
              if (!profile) continue
              for (const runtimeID of profile.runtimes) {
                const runtimeDefinition = pack.runtimes.find((definition) => definition.id === runtimeID)
                if (!runtimeDefinition) continue
                const key = registrationKey(pack.id, profileID, runtimeDefinition, fingerprint)
                const existing = shared.get(key)
                if (existing) {
                  existing.count++
                  added.push(key)
                  continue
                }
                const reference = references.find(
                  (item) => item.key === runtimeKey(pack.id, runtimeDefinition, fingerprint),
                )
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
                          const canonical =
                            current.permission?.resource ?? canonicalResource(runtimeID, definition.name)
                          const checked = permissionResources(canonical, input)
                          if (Result.isFailure(checked)) {
                            return Effect.fail(new ToolFailure({ message: checked.failure.message }))
                          }
                          const authorization = {
                            action: current.permission?.action ?? definition.name,
                            resources: checked.success,
                            save: [canonical],
                            sessionID: context.sessionID,
                            agent: context.agent,
                            source: {
                              type: "tool" as const,
                              messageID: context.assistantMessageID,
                              callID: context.toolCallID,
                            },
                          }
                          return (context.permission ?? permission).assert(authorization).pipe(
                            Effect.mapError(
                              () => new ToolFailure({ message: `Permission denied: ${definition.name}` }),
                            ),
                            Effect.andThen(
                              current.call(input, context.abortSignal).pipe(
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
                      {
                        type: "mcp",
                        serverID: runtimeDefinition.mcp ?? runtimeID,
                        capability: pack.id,
                        profile: profileID,
                      },
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

    const activateLocked = (
      sessionID: SessionSchema.ID,
      pack: CapabilityCatalog.Pack,
      profiles: ReadonlyArray<ProfileID>,
      dependencies: ReadonlyArray<DependencyHealth>,
      persist: boolean,
      agentID?: AgentV2.ID,
    ): Effect.Effect<EnableOutput, ToolFailure> =>
      Effect.gen(function* () {
        const key = activationKey(sessionID, pack.id)
        let previous = held.get(key)
        const fingerprint = manifestFingerprint(pack)
        if (previous && previous.fingerprint !== fingerprint) {
          yield* dropHeld(key, previous)
          previous = undefined
        }
        if (!compatible(pack, profiles)) {
          const output = failedOutput(pack, profiles, dependencies, "unsupported")
          failures.set(key, {
            checkedAt: yield* Clock.currentTimeMillis,
            remediation: output.remediation,
          })
          return output
        }
        const missing = dependencies.filter((dependency) => dependency.state === "missing")
        if (missing.length > 0) {
          const output = failedOutput(pack, profiles, dependencies, "failed")
          failures.set(key, {
            checkedAt: Math.max(...missing.map((dependency) => dependency.checkedAt)),
            remediation: output.remediation,
          })
          return output
        }
        const definitions = selectedRuntimes(pack, profiles)
        const result = yield* runtime.activate(
          definitions.map((definition) => ({ key: runtimeKey(pack.id, definition, fingerprint), definition })),
        )
        if (result.state === "failed") {
          const output = failedOutput(pack, profiles, dependencies, "failed")
          failures.set(key, {
            checkedAt: yield* Clock.currentTimeMillis,
            remediation: output.remediation,
          })
          return output
        }

        const registrations = yield* register(pack, profiles, result.references).pipe(
          Effect.mapError(() => new ToolFailure({ message: `Capability tools could not be registered: ${pack.id}` })),
          Effect.onError(() => releaseReferences(result.references)),
          Effect.uninterruptible,
        )
        const next: Held = { pack, fingerprint, profiles, references: result.references, registrations }
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
          held.set(key, next)
          failures.delete(key)
          if (previous) yield* release(previous)
        }).pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? release(next) : Effect.void)),
          Effect.uninterruptible,
        )

        const rules = (yield* agents.resolve(agentID))?.permissions ?? []
        const availableTools = definitions
          .flatMap((definition) => {
            const reference = result.references.find(
              (item) => item.key === runtimeKey(pack.id, definition, fingerprint),
            )
            return (
              reference?.value?.tools.filter(
                (tool) =>
                  PermissionV2.evaluate(tool.name, canonicalResource(definition.id, tool.name), rules).effect !==
                    "deny" &&
                  (!tool.permission ||
                    PermissionV2.evaluate(tool.permission.action, tool.permission.resource, rules).effect !== "deny"),
              ) ?? []
            ).map((tool) => tool.name)
          })
          .filter(distinct)
          .toSorted()
        const availableSkills = selectedSkills(pack, profiles).filter(
          (skill) => PermissionV2.evaluate("skill", skill, rules).effect !== "deny",
        )
        return {
          id: pack.id,
          profiles,
          state: activationState,
          nextTurn: true,
          tools: availableTools,
          skills: availableSkills,
          availableTools,
          availableSkills,
          permissionFiltered: true,
          dependencies,
          remediation: dependencies.flatMap((dependency) => dependency.remediation ?? []),
        }
      })

    const ensure = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        const heldSessions = new Set([...held.keys()].map(sessionFromActivationKey))
        yield* Effect.forEach(
          heldSessions,
          (heldSessionID) =>
            Effect.gen(function* () {
              if (yield* sessions.get(heldSessionID)) return
              const entries = [...held.entries()].filter(([key]) => key.startsWith(`${heldSessionID}\u0000`))
              yield* Effect.forEach(
                entries,
                ([key, expected]) =>
                  locks.withLock(key)(
                    Effect.gen(function* () {
                      if (yield* sessions.get(heldSessionID)) return
                      yield* dropHeld(key, expected)
                    }),
                  ),
                { discard: true },
              )
            }),
          { concurrency: "unbounded", discard: true },
        )
        const activations = yield* state.list(sessionID)
        const active = new Set(activations.map((item) => activationKey(sessionID, item.id)))
        const stale = [...held.entries()].filter(([key]) => key.startsWith(`${sessionID}\u0000`) && !active.has(key))
        yield* Effect.forEach(
          stale,
          ([key, expected]) =>
            locks.withLock(key)(
              Effect.gen(function* () {
                const current = (yield* state.list(sessionID)).find(
                  (activation) => activationKey(sessionID, activation.id) === key,
                )
                if (!current) yield* dropHeld(key, expected)
              }),
            ),
          { discard: true },
        )
        const outcomes = yield* Effect.forEach(
          activations,
          (item) =>
            locks.withLock(activationKey(sessionID, item.id))(
              Effect.gen(function* () {
                const key = activationKey(sessionID, item.id)
                const activation = (yield* state.list(sessionID)).find((current) => current.id === item.id)
                const current = held.get(key)
                if (!activation) {
                  if (current) yield* dropHeld(key, current)
                  return item.id
                }
                const pack = yield* catalog.get(item.id)
                const profiles = pack ? validProfiles(pack, activation.profiles) : undefined
                if (!pack || !profiles) {
                  if (current) yield* dropHeld(key, current)
                  return item.id
                }
                const fingerprint = manifestFingerprint(pack)
                if (current && current.fingerprint === fingerprint && sameProfiles(current.profiles, profiles)) {
                  const unavailableRequired = selectedRuntimes(pack, profiles)
                    .filter((definition) => !definition.optional)
                    .some(
                      (definition) =>
                        !current.references.find(
                          (reference) => reference.key === runtimeKey(pack.id, definition, fingerprint),
                        )?.available,
                    )
                  if (!unavailableRequired) return undefined
                }
                if (current) yield* dropHeld(key, current)
                const dependencies = compatible(pack, profiles) ? yield* probe(pack, profiles) : []
                const output = yield* activateLocked(sessionID, pack, profiles, dependencies, false).pipe(Effect.result)
                return Result.isSuccess(output) && output.success.nextTurn ? undefined : item.id
              }),
            ),
          { concurrency: "unbounded" },
        )
        return new Set(outcomes.filter((id): id is string => id !== undefined))
      })

    const enable = (
      input: EnableInput,
      context: ManagementContext,
      authorization: Effect.Effect<void, ToolFailure> = Effect.void,
    ) => {
      let runtimeCount = 0
      const operation = Effect.suspend(() =>
        locks.withLock(activationKey(context.sessionID, input.id))(
          Effect.gen(function* () {
            const pack = yield* catalog.get(input.id)
            if (!pack) return yield* new ToolFailure({ message: `Capability manifest not found: ${input.id}` })
            const key = activationKey(context.sessionID, input.id)
            const durable = (yield* state.list(context.sessionID)).find((activation) => activation.id === input.id)
            const current = held.get(key)
            if (
              current &&
              (!durable ||
                current.fingerprint !== manifestFingerprint(pack) ||
                !sameProfiles(current.profiles, durable.profiles))
            ) {
              yield* dropHeld(key, current)
            }
            const aliases = input.profiles?.length ? input.profiles : undefined
            if (aliases && input.profile && (aliases.length !== 1 || aliases[0] !== input.profile)) {
              return yield* new ToolFailure({
                message: `Conflicting capability profile aliases: profile=${input.profile}, profiles=${aliases.join(",")}`,
              })
            }
            const available = Object.keys(pack.profiles).map((profile) => CapabilityManifest.ID.make(profile))
            const requested =
              aliases ??
              (input.profile
                ? [input.profile]
                : Object.hasOwn(pack.profiles, "default")
                  ? [CapabilityManifest.ID.make("default")]
                  : available.length === 1
                    ? available
                    : undefined)
            if (!requested) {
              return yield* new ToolFailure({
                message: `Capability ${input.id} requires a profile. Available profiles: ${available.join(", ")}`,
              })
            }
            const profiles = validProfiles(pack, requested)
            if (!profiles) {
              const missing = requested.find((profile) => !Object.hasOwn(pack.profiles, profile)) ?? "default"
              return yield* new ToolFailure({ message: `Capability profile not found: ${input.id}/${missing}` })
            }
            runtimeCount = selectedRuntimes(pack, profiles).length
            const dependencies = compatible(pack, profiles) ? yield* probe(pack, profiles) : []
            return yield* activateLocked(context.sessionID, pack, profiles, dependencies, true, context.agent)
          }),
        ),
      )
      return CapabilityEvent.observeActivation(
        eventBus,
        { capabilityID: input.id, runtimeCount: () => runtimeCount },
        authorization.pipe(Effect.andThen(operation)),
      )
    }

    const disable = (input: DisableInput, context: ManagementContext) =>
      Effect.suspend(() =>
        locks.withLock(activationKey(context.sessionID, input.id))(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* state.disable({ sessionID: context.sessionID, id: input.id })
              const key = activationKey(context.sessionID, input.id)
              failures.delete(key)
              // Existing advertised snapshots keep their registrations and clients until
              // the next materialization boundary, where ensure releases stale holds.
              return { id: input.id, state: "disabled" as const, nextTurn: true }
            }),
          ),
        ),
      )

    const status = (input: StatusInput, context: StatusContext) =>
      Effect.gen(function* () {
        const installed = (yield* catalog.list()).filter((pack) => input.id === undefined || pack.id === input.id)
        const activations = context.sessionID ? yield* state.status(context.sessionID) : []
        const active = new Map(activations.map((item) => [item.id, item]))
        const statuses = yield* Effect.forEach(installed, (pack) =>
          Effect.gen(function* () {
            const activation = active.get(pack.id)
            const dependencies = yield* probe(pack)
            const profiles = activation ? validProfiles(pack, activation.profiles) : undefined
            const fingerprint = manifestFingerprint(pack)
            const selectedRuntimeDefinitions = selectedRuntimes(pack, profiles ?? [])
            const runtimeStatuses = yield* Effect.forEach(selectedRuntimeDefinitions, (definition) =>
              runtime
                .status(runtimeKey(pack.id, definition, fingerprint))
                .pipe(Effect.map((status) => [definition.id, status] as const)),
            )
            const runtimeByID = new Map(runtimeStatuses)
            const profileStatus = Object.fromEntries(
              Object.keys(pack.profiles).map((profile) => {
                const id = CapabilityManifest.ID.make(profile)
                const selected = profiles?.includes(id) === true
                return [
                  id,
                  statusForProfile(
                    pack,
                    id,
                    dependencies,
                    selected
                      ? (pack.profiles[id]?.runtimes ?? []).flatMap((runtimeID) => {
                          const status = runtimeByID.get(runtimeID)
                          return status ? [status] : []
                        })
                      : [],
                  ),
                ]
              }),
            )
            const remembered = context.sessionID ? failures.get(activationKey(context.sessionID, pack.id)) : undefined
            const checkedAt = Math.max(
              remembered?.checkedAt ?? 0,
              ...dependencies.map((dependency) => dependency.checkedAt),
              ...runtimeStatuses.map(([, status]) => status.updatedAt),
            )
            const invalidProfiles = activation !== undefined && profiles === undefined
            const selectedStates = profiles?.map((profile) => profileStatus[profile]?.state) ?? []
            const compatibleStates = Object.values(profileStatus)
              .map((status) => status.state)
              .filter((status) => status !== "unsupported")
            const failed = selectedStates.includes("failed") || remembered !== undefined
            const degraded = activation?.state === "degraded" || selectedStates.includes("degraded")
            const inactiveState = compatibleStates.some((state) => state === "healthy" || state === "degraded")
              ? ("installed" as const)
              : compatibleStates.includes("failed")
                ? ("failed" as const)
                : ("unsupported" as const)
            const currentState = !compatible(pack)
              ? ("unsupported" as const)
              : invalidProfiles
                ? ("unavailable" as const)
                : activation
                  ? selectedStates.includes("unsupported")
                    ? ("unsupported" as const)
                    : failed
                      ? ("failed" as const)
                      : degraded
                        ? ("degraded" as const)
                        : ("active" as const)
                  : inactiveState
            const relevantProfileStatuses = activation
              ? (profiles ?? []).flatMap((profile) => {
                  const status = profileStatus[profile]
                  return status ? [status] : []
                })
              : Object.values(profileStatus)
            const remediation = [
              ...(remembered?.remediation ?? []),
              ...relevantProfileStatuses.flatMap((status) => status.remediation),
              ...(invalidProfiles
                ? [`Select profiles currently declared by ${pack.id}, or disable the stale activation.`]
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
              profileStatus,
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
            profileStatus: {},
            remediation: [`Restore the installed manifest for ${activation.id}, or disable the stale activation.`],
          }))
        return {
          capabilities: [...statuses, ...unavailable].toSorted((left, right) => left.id.localeCompare(right.id)),
        }
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
              yield* authorize(context, "capability_search", [input.query])
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
          description:
            "Enable one installed capability pack for this session. Prefer the singular profile field for one profile; profiles remains supported for multiple profiles. New tools and skills appear next turn.",
          input: Schema.Struct({
            id: CapabilityManifest.ID,
            profile: CapabilityManifest.ID.pipe(Schema.optional),
            profiles: RequestedProfiles.pipe(Schema.optional),
          }),
          output: EnableOutput,
          execute: (input, context) => enable(input, context, authorize(context, "capability_enable", [input.id])),
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
            authorize(context, "capability_disable", [input.id]).pipe(Effect.andThen(disable(input, context))),
        }),
        capability_status: Tool.make({
          description:
            "Report installed and active capability health with concise remediation and no raw process logs.",
          input: Schema.Struct({ id: CapabilityManifest.ID.pipe(Schema.optional) }),
          output: Schema.Struct({ capabilities: Schema.Array(CapabilityStatus).check(Schema.isMaxLength(256)) }),
          execute: (input, context) =>
            authorize(context, "capability_status", [input.id ?? "*"]).pipe(Effect.andThen(status(input, context))),
        }),
      })
      .pipe(Effect.orDie)

    yield* Effect.addFinalizer(() =>
      Effect.forEach(held.values(), release, { concurrency: "unbounded", discard: true }),
    )
    return Service.of({
      refresh: (reference) =>
        Effect.sync(() => {
          referenceVersions.set(reference, (referenceVersions.get(reference) ?? 0) + 1)
        }),
      enable: (input) => enable(input, input),
      disable: (input) => disable(input, input),
      status: (sessionID) => status({}, { sessionID }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    ToolRegistry.node,
    CapabilityCatalog.node,
    CapabilityState.node,
    CapabilityRuntime.node,
    AppProcess.node,
    PermissionV2.node,
    AgentV2.node,
    SessionStore.node,
    EventV2.node,
  ],
})

function activationKey(sessionID: SessionSchema.ID, id: string) {
  return `${sessionID}\u0000${id}`
}

function runtimeKey(pack: string, runtime: CapabilityManifest.Runtime, manifest: string) {
  const fingerprint = Hash.sha256(JSON.stringify({ manifest, runtime }))
  return `${pack}/${runtime.id}#${fingerprint}`
}

function registrationKey(
  pack: string,
  profile: string,
  runtime: CapabilityManifest.Runtime,
  manifestFingerprint: string,
) {
  return `${pack}\u0000${profile}\u0000${runtimeKey(pack, runtime, manifestFingerprint)}`
}

function sessionFromActivationKey(key: string) {
  return SessionSchema.ID.make(key.slice(0, key.indexOf("\u0000")))
}

function originalManifestFingerprint(pack: CapabilityCatalog.Pack) {
  return Hash.sha256(
    JSON.stringify({
      id: pack.id,
      version: pack.version,
      platforms: pack.platforms,
      profiles: pack.profiles,
      runtimes: pack.runtimes,
      dependencies: pack.dependencies,
      skills: pack.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.path,
        content: skill.content,
      })),
    }),
  )
}

function canonicalResource(serverID: string, tool: string) {
  return `mcp:${serverID}:${tool}`
}

function permissionResources(canonical: string, input: unknown) {
  const resources = new Set<string>([canonical])
  const pending: unknown[] = [input]
  const seen = new WeakSet<object>()
  let visited = 0
  while (pending.length > 0) {
    const value = pending.pop()
    visited++
    if (visited > MAX_PERMISSION_INPUT_NODES) return Result.fail(new PermissionResourceOverflow())
    if (typeof value === "string") {
      if (value.length === 0 || value === "*") continue
      if (value.length > MAX_PERMISSION_RESOURCE_LENGTH) return Result.fail(new PermissionResourceOverflow())
      if (!resources.has(value) && resources.size >= MAX_PERMISSION_RESOURCES) {
        return Result.fail(new PermissionResourceOverflow())
      }
      resources.add(value)
      continue
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) continue
      seen.add(value)
      if (visited + pending.length + value.length > MAX_PERMISSION_INPUT_NODES) {
        return Result.fail(new PermissionResourceOverflow())
      }
      pending.push(...value.toReversed())
      continue
    }
    if (!value || typeof value !== "object" || seen.has(value)) continue
    seen.add(value)
    const values = Object.values(value)
    if (visited + pending.length + values.length > MAX_PERMISSION_INPUT_NODES) {
      return Result.fail(new PermissionResourceOverflow())
    }
    pending.push(...values.toReversed())
  }
  return Result.succeed([...resources])
}

function distinct<T>(value: T, index: number, values: ReadonlyArray<T>) {
  return values.indexOf(value) === index
}

function compatible(pack: CapabilityCatalog.Pack, profiles?: ReadonlyArray<ProfileID>) {
  const platform = process.platform
  if (platform !== "darwin" && platform !== "linux") return false
  const selected = profiles ?? Object.keys(pack.profiles).map((profile) => CapabilityManifest.ID.make(profile))
  if (profiles) return selected.every((profile) => profilePlatforms(pack, profile).includes(platform))
  return selected.some((profile) => profilePlatforms(pack, profile).includes(platform))
}

function compatibleProfiles(pack: CapabilityCatalog.Pack) {
  return Object.keys(pack.profiles)
    .map((profile) => CapabilityManifest.ID.make(profile))
    .filter((profile) => compatible(pack, [profile]))
}

function profilePlatforms(pack: CapabilityCatalog.Pack, profile: ProfileID) {
  return pack.profiles[profile]?.platforms ?? pack.platforms
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

function selectedDependencies(pack: CapabilityCatalog.Pack, profiles: ReadonlyArray<ProfileID>) {
  const selected = new Set(profiles)
  return (pack.dependencies ?? []).filter(
    (dependency) => dependency.profiles === undefined || dependency.profiles.some((profile) => selected.has(profile)),
  )
}

function statusForProfile(
  pack: CapabilityCatalog.Pack,
  profile: ProfileID,
  dependencies: ReadonlyArray<DependencyHealth>,
  runtimes: ReadonlyArray<CapabilityRuntime.Status>,
): ProfileHealth {
  if (!compatible(pack, [profile])) {
    return {
      state: "unsupported",
      checkedAt: 0,
      dependencies: [],
      remediation: [
        `Use ${pack.id}/${profile} on one of its supported platforms: ${profilePlatforms(pack, profile).join(", ")}.`,
      ],
    }
  }
  const selected = new Set(selectedDependencies(pack, [profile]).map((dependency) => dependency.id))
  const health = dependencies.filter((dependency) => selected.has(dependency.id))
  const failed =
    health.some((dependency) => dependency.state === "missing") || runtimes.some((item) => item.state === "failed")
  const degraded =
    health.some((dependency) => dependency.state === "optional-missing") ||
    runtimes.some((item) => item.state === "degraded")
  return {
    state: failed ? "failed" : degraded ? "degraded" : "healthy",
    checkedAt: Math.max(
      0,
      ...health.map((dependency) => dependency.checkedAt),
      ...runtimes.map((item) => item.updatedAt),
    ),
    dependencies: health,
    remediation: [
      ...health.flatMap((dependency) => dependency.remediation ?? []),
      ...(runtimes.some((item) => item.state === "failed")
        ? [`Retry capability_enable for ${pack.id}/${profile}; if it still fails, verify its runtime configuration.`]
        : []),
    ],
  }
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
    availableTools: [],
    availableSkills: [],
    permissionFiltered: true,
    dependencies,
    remediation:
      state === "unsupported"
        ? [
            `Use ${pack.id}/${profiles.join(",")} on one of its supported platforms: ${[
              ...new Set(profiles.flatMap((profile) => profilePlatforms(pack, profile))),
            ].join(", ")}.`,
          ]
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
