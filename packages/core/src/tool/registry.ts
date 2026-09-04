export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { CapabilityEvent } from "../capability/event"
import { CapabilityState } from "../capability/state"
import { CapabilityTokenEstimate } from "../capability/token-estimate"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import {
  definition,
  origin,
  permission,
  settle,
  validateName,
  type AnyTool,
  type Permission as ToolPermission,
  type RegistrationError,
} from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"
import { Hash } from "../util/hash"

export const MATERIALIZATION_SNAPSHOT_LIMIT = 256

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
  readonly abortSignal?: AbortSignal
  readonly permission?: ToolPermission
}

export interface Interface {
  readonly materialize: (
    sessionID: SessionSchema.ID,
    permissions?: PermissionV2.Ruleset,
  ) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolRegistry") {}

export interface MaterializationHooksInterface {
  readonly register: (
    prepare: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlySet<string>>,
  ) => Effect.Effect<void, never, Scope.Scope>
}

export class MaterializationHooks extends Context.Service<MaterializationHooks, MaterializationHooksInterface>()(
  "@opencode/v2/ToolRegistry/MaterializationHooks",
) {}

const registryLayer = Layer.effectContext(
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const capabilities = yield* CapabilityState.Service
    const events = yield* EventV2.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    type Active = ReadonlyMap<string, ReadonlySet<string>>
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()
    const materializationHooks: Array<{
      readonly token: object
      readonly prepare: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlySet<string>>
    }> = []
    const materializationSnapshots = new Map<SessionSchema.ID, ReadonlyMap<string, string>>()
    const materializationLocks = KeyedMutex.makeUnsafe<SessionSchema.ID>()

    const visible = (registration: Registration, active: Active) => {
      const source = origin(registration.tool)
      if (!source || !("capability" in source) || source.capability === undefined) return true
      const profiles = active.get(source.capability)
      return profiles !== undefined && (source.profile === undefined || profiles.has(source.profile))
    }

    const resolve = (name: string, active: Active) => {
      const registration = local.get(name)?.findLast((entry) => visible(entry.registration, active))?.registration
      if (registration) return registration
      const application = applications.entries().get(name)
      return application && visible(application, active) ? application : undefined
    }

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (
      input: ExecuteInput,
      advertised: object,
      active: Active,
    ) {
      const registration = resolve(input.call.name, active)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: `Stale tool call: ${input.call.name}`,
          },
        }
      if (registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        abortSignal: input.abortSignal,
        permission: input.permission,
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    const service = Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool } }])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (sessionID, permissions = []) {
        const unavailable = new Set(
          (yield* Effect.forEach(materializationHooks, (hook) => hook.prepare(sessionID), {
            concurrency: "unbounded",
          })).flatMap((items) => [...items]),
        )
        const active = new Map(
          (yield* capabilities.list(sessionID))
            .filter((activation) => !unavailable.has(activation.id))
            .map((activation) => [activation.id, new Set(activation.profiles)]),
        )
        const names = new Set([...applications.entries().keys(), ...local.keys()])
        const registrations = new Map<string, Registration>()
        const baseline = new Map<string, Registration>()
        for (const name of names) {
          const registration = resolve(name, active)
          if (registration) registrations.set(name, registration)
          const base = resolve(name, new Map())
          if (base) baseline.set(name, base)
        }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions)) registrations.delete(name)
        for (const [name, registration] of baseline)
          if (whollyDisabled(permission(registration.tool, name), permissions)) baseline.delete(name)
        const definitions = Array.from(registrations, ([name, registration]) => definition(name, registration.tool))
        const baselineDefinitions = Array.from(baseline, ([name, registration]) => definition(name, registration.tool))
        yield* materializationLocks.withLock(sessionID)(
          Effect.gen(function* () {
            const baselineSnapshot = snapshotDefinitions(baselineDefinitions)
            const previous = materializationSnapshots.get(sessionID) ?? baselineSnapshot
            if (materializationSnapshots.has(sessionID)) {
              materializationSnapshots.delete(sessionID)
              materializationSnapshots.set(sessionID, previous)
            }
            const current = snapshotDefinitions(definitions)
            const added = changedDefinitions(current, previous)
            const removed = changedDefinitions(previous, current)
            if (added > 0) {
              yield* CapabilityEvent.publish(events, { type: "capability.definitions.added", count: added })
            }
            if (removed > 0) {
              yield* CapabilityEvent.publish(events, { type: "capability.definitions.removed", count: removed })
            }
            const estimate = CapabilityTokenEstimate.compare(baselineDefinitions, definitions)
            yield* CapabilityEvent.publish(events, {
              type: "capability.schema.estimated",
              state: sameDefinitions(current, baselineSnapshot) ? "baseline" : "active",
              definitionCount: definitions.length,
              ...estimate,
            })
            if (sameDefinitions(current, baselineSnapshot)) materializationSnapshots.delete(sessionID)
            else {
              materializationSnapshots.delete(sessionID)
              while (materializationSnapshots.size >= MATERIALIZATION_SNAPSHOT_LIMIT) {
                const oldest = materializationSnapshots.keys().next().value
                if (oldest === undefined) break
                materializationSnapshots.delete(oldest)
              }
              materializationSnapshots.set(sessionID, current)
            }
          }),
        )
        return {
          definitions,
          settle: (input) => {
            if (input.sessionID !== sessionID)
              return Effect.succeed({
                result: { type: "error", value: "Tool materialization belongs to another session" },
              })
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity, active)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
    })
    const hooks = MaterializationHooks.of({
      register: (prepare) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            materializationHooks.push({ token, prepare })
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                const index = materializationHooks.findIndex((hook) => hook.token === token)
                if (index >= 0) materializationHooks.splice(index, 1)
              }),
            )
          }),
        ),
    })
    return Context.make(Service, service).pipe(Context.add(MaterializationHooks, hooks))
  }),
)

const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node, CapabilityState.node, EventV2.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node, CapabilityState.node, EventV2.node],
})

function snapshotDefinitions(definitions: ReadonlyArray<ToolDefinition>) {
  return new Map(
    definitions.map(
      (definition) => [definition.name, Hash.sha256(CapabilityTokenEstimate.serialize([definition]))] as const,
    ),
  )
}

function changedDefinitions(current: ReadonlyMap<string, string>, previous: ReadonlyMap<string, string>) {
  return [...current].filter(([name, schema]) => previous.get(name) !== schema).length
}

function sameDefinitions(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>) {
  return left.size === right.size && [...left].every(([name, schema]) => right.get(name) === schema)
}
