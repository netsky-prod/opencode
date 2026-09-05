export * as CapabilityRuntime from "./runtime"

import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { CapabilityRuntime as CoreCapabilityRuntime } from "@opencode-ai/core/capability/runtime"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { Cause, Effect, Exit, Layer } from "effect"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Location } from "@opencode-ai/core/location"

export type Tool = CoreCapabilityRuntime.Tool

export function tools(reference: CoreCapabilityRuntime.Reference): ReadonlyArray<Tool> {
  return reference.value?.tools ?? []
}

const layer = Layer.effect(
  CoreCapabilityRuntime.Service,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const events = yield* EventV2.Service
    const makeObserved = (adapter: CoreCapabilityRuntime.Adapter) => CoreCapabilityRuntime.make(adapter, { events })
    const runtimes = yield* InstanceState.make(
      Effect.fn("CapabilityRuntime.state")(function* () {
        const bridge = yield* EffectBridge.make()
        const owners = new Map<string, { readonly lineage: string; readonly registrations: Set<MCP.Registration> }>()
        const releaseOwnership = (registration: MCP.Registration) => {
          for (const [name, owner] of owners) {
            if (!owner.registrations.delete(registration)) continue
            if (owner.registrations.size === 0) owners.delete(name)
          }
        }

        return yield* makeObserved({
          start: (key, definition) => {
            const server = serverName(key)
            let registration: MCP.Registration | undefined
            const cleanup = Effect.gen(function* () {
              if (!registration) return
              releaseOwnership(registration)
              yield* mcp.remove(registration).pipe(Effect.catchTag("MCP.NotFoundError", () => Effect.void))
            })
            return Effect.gen(function* () {
              if (definition.type !== "mcp") throw new Error(`Unsupported capability runtime type: ${definition.type}`)
              if (runtimeID(key) !== definition.id) throw new Error(`Capability runtime key does not match: ${key}`)
              const reference = definition.mcp ? yield* mcp.config(definition.mcp) : undefined
              if (definition.mcp && !reference) throw new Error("Configured MCP reference is unavailable")
              if (reference?.enabled === false) throw new Error("Configured MCP reference is disabled")
              // Always-on connections retain their one original tool catalog. A reference
              // does not acquire or rename them, and releasing a pack never closes them.
              if (reference && reference.exposure !== "pack-only") {
                if ((yield* mcp.connection(definition.mcp!))?.status !== "connected") {
                  throw new Error("Configured MCP connection is unavailable; check or authenticate the server")
                }
                return { value: Object.freeze({ tools: [] }), stop: Effect.void, exited: Effect.never }
              }
              const configured = reference
                ? { info: { ...reference, enabled: true }, sensitive: sensitiveConfig(reference) }
                : yield* Effect.try({
                    try: () => mcpConfig(definition),
                    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
                  })
              const lineage = definition.mcp ? `reference:${definition.mcp}` : `${packID(key)}\0${runtimeID(key)}`
              if (yield* mcp.connection(server)) throw new Error(`MCP server name is already registered: ${server}`)
              const existing = new Set(Object.keys(yield* mcp.tools()))
              return yield* Effect.gen(function* () {
                const added = yield* mcp.add(server, configured.info, { hidden: true, authName: definition.mcp })
                const owned = added.registration
                registration = owned
                const connection = isStatus(added.status) ? added.status : added.status[server]
                if (connection?.status !== "connected") {
                  throw new Error(
                    connection?.status === "failed"
                      ? connection.error
                      : `MCP server did not connect (${connection?.status ?? "unknown"})`,
                  )
                }

                const upstream = yield* mcp.definitions(server)
                const names = upstream.map((upstreamDefinition) =>
                  definition.mcp
                    ? McpCatalog.toolName(definition.mcp, upstreamDefinition.upstreamName)
                    : CapabilityManifest.canonicalName(
                        packID(key),
                        runtimeID(key),
                        McpCatalog.sanitize(upstreamDefinition.upstreamName),
                      ),
                )
                const collision = names.find(
                  (name, index) =>
                    names.indexOf(name) !== index ||
                    existing.has(name) ||
                    (owners.has(name) && owners.get(name)?.lineage !== lineage),
                )
                if (collision) {
                  throw new Error(`Canonical tool name collision: ${collision}`)
                }
                for (const name of names) {
                  const owner = owners.get(name)
                  if (owner) owner.registrations.add(owned)
                  else owners.set(name, { lineage, registrations: new Set([owned]) })
                }

                const definitions = Object.freeze(
                  upstream.map((upstreamDefinition, index) =>
                    Object.freeze({
                      name: names[index],
                      ...(definition.mcp
                        ? {
                            permission: {
                              action: McpCatalog.toolName(definition.mcp, upstreamDefinition.upstreamName),
                              resource: `mcp:${definition.mcp}:${McpCatalog.toolName(definition.mcp, upstreamDefinition.upstreamName)}`,
                            },
                          }
                        : {}),
                      description: upstreamDefinition.description,
                      inputSchema: upstreamDefinition.inputSchema,
                      call: upstreamDefinition.call,
                    }),
                  ),
                )
                const stop = bridge.run(
                  Effect.gen(function* () {
                    releaseOwnership(owned)
                    yield* mcp.remove(owned).pipe(Effect.catchTag("MCP.NotFoundError", () => Effect.void))
                  }),
                )

                return {
                  value: Object.freeze({ tools: definitions }),
                  stop,
                  exited: bridge.run(waitForExit(mcp, owned)),
                }
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.fail(new Error(redactResolved(Cause.pretty(cause), configured.sensitive))),
                ),
              )
            }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? cleanup : Effect.void)))
          },
        })
      }),
    )

    return CoreCapabilityRuntime.Service.of({
      acquire: (key, definition) =>
        InstanceState.get(runtimes).pipe(Effect.flatMap((runtime) => runtime.acquire(key, definition))),
      release: (reference) => InstanceState.get(runtimes).pipe(Effect.flatMap((runtime) => runtime.release(reference))),
      activate: (definitions) =>
        InstanceState.get(runtimes).pipe(Effect.flatMap((runtime) => runtime.activate(definitions))),
      status: (key) => InstanceState.get(runtimes).pipe(Effect.flatMap((runtime) => runtime.status(key))),
    })
  }),
)

export const node = makeLocationNode({
  service: CoreCapabilityRuntime.Service,
  layer,
  deps: [MCP.node, EventV2.node],
})

// Core background execution has a Location, not an HTTP/legacy InstanceRef.
// Bind the host boundary once per location while retaining the legacy node for
// callers that already route their own instance context.
export const adapterNode = makeLocationNode({
  service: CoreCapabilityRuntime.Service,
  layer: Layer.effect(
    CoreCapabilityRuntime.Service,
    Effect.gen(function* () {
      const runtime = yield* CoreCapabilityRuntime.Service
      const location = yield* Location.Service
      const instances = yield* InstanceStore.Service
      const bind = <A, E>(effect: Effect.Effect<A, E>) =>
        instances
          .provide({ directory: location.directory }, effect)
          .pipe(Effect.provideService(WorkspaceRef, location.workspaceID))
      return CoreCapabilityRuntime.Service.of({
        acquire: (key, definition) => bind(runtime.acquire(key, definition)),
        release: (reference) => bind(runtime.release(reference)),
        activate: (definitions) => bind(runtime.activate(definitions)),
        status: (key) => bind(runtime.status(key)),
      })
    }),
  ).pipe(Layer.provide(layer)),
  deps: [MCP.node, EventV2.node, InstanceStore.node, Location.node],
})

function mcpConfig(definition: CapabilityManifest.Runtime): {
  readonly info: ConfigMCPV1.Info
  readonly sensitive: ReadonlyArray<string>
} {
  const sensitive = new Set<string>()
  const commandLine = (definition.command ?? []).map((value) => resolveEnvironment(value, sensitive))
  const environment = definition.environment
    ? Object.fromEntries(
        Object.entries(definition.environment).map(([name, value]) => [name, resolveEnvironment(value, sensitive)]),
      )
    : undefined
  const [command, ...args] = commandLine
  if (!command) throw new Error(`Capability runtime command is empty: ${definition.id}`)
  if (commandLine.length === 1 && URL.canParse(command)) {
    return {
      info: {
        type: "remote",
        url: command,
        headers: environment,
        oauth: false,
        timeout: definition.timeoutMs,
      },
      sensitive: [...sensitive],
    }
  }
  return {
    info: {
      type: "local",
      command: [command, ...args],
      environment,
      timeout: definition.timeoutMs,
    },
    sensitive: [...sensitive],
  }
}

const environmentReference = /^\$\{([A-Z_][A-Z0-9_]*)\}$/

function resolveEnvironment(value: string, sensitive: Set<string>) {
  const match = environmentReference.exec(value)
  if (!match) return value
  const name = match[1]
  const resolved = process.env[name]
  if (resolved === undefined || resolved === "") throw new Error(`Missing environment variable ${name}`)
  sensitive.add(resolved)
  return resolved
}

function redactResolved(message: string, sensitive: ReadonlyArray<string>) {
  return sensitive
    .toSorted((left, right) => right.length - left.length)
    .reduce((result, value) => result.replaceAll(value, "[redacted]"), message)
}

function sensitiveConfig(config: ConfigMCPV1.Info) {
  return config.type === "local"
    ? [...config.command.slice(1), ...Object.values(config.environment ?? {})].filter(Boolean)
    : [
        config.url,
        ...Object.values(config.headers ?? {}),
        ...(typeof config.oauth === "object" ? [config.oauth.clientSecret ?? ""] : []),
      ].filter(Boolean)
}

function isStatus(status: Record<string, MCP.Status> | MCP.Status): status is MCP.Status {
  return typeof status.status === "string"
}

function serverName(key: string) {
  return `__capability_${McpCatalog.sanitize(key)}`
}

function packID(key: string) {
  const index = key.indexOf("/")
  if (index <= 0) throw new Error(`Invalid capability runtime key: ${key}`)
  return key.slice(0, index)
}

function runtimeID(key: string) {
  const index = key.indexOf("/")
  if (index <= 0 || index === key.length - 1 || key.indexOf("/", index + 1) !== -1) {
    throw new Error(`Invalid capability runtime key: ${key}`)
  }
  const fingerprint = key.indexOf("#", index + 1)
  if (fingerprint === -1) return key.slice(index + 1)
  if (fingerprint === index + 1 || fingerprint === key.length - 1 || key.indexOf("#", fingerprint + 1) !== -1) {
    throw new Error(`Invalid capability runtime key: ${key}`)
  }
  return key.slice(index + 1, fingerprint)
}

function waitForExit(mcp: MCP.Interface, registration: MCP.Registration): Effect.Effect<void> {
  return Effect.gen(function* () {
    while ((yield* mcp.connection(registration))?.status === "connected") yield* Effect.sleep("1 second")
  })
}
