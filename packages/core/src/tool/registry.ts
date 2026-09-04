export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { CapabilityState } from "../capability/state"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { definition, origin, permission, settle, validateName, type AnyTool, type RegistrationError } from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
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
    const resources = yield* ToolOutputStore.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    type Active = ReadonlyMap<string, ReadonlySet<string>>
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()
    const materializationHooks: Array<{
      readonly token: object
      readonly prepare: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlySet<string>>
    }> = []

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
        const registrations = new Map<string, Registration>()
        for (const name of new Set([...applications.entries().keys(), ...local.keys()])) {
          const registration = resolve(name, active)
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions)) registrations.delete(name)
        return {
          definitions: Array.from(registrations, ([name, registration]) => definition(name, registration.tool)),
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
  deps: [ApplicationTools.node, ToolOutputStore.node, CapabilityState.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node, CapabilityState.node],
})
