export * as CapabilityRuntime from "./runtime"

import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { CapabilityRuntime as CoreCapabilityRuntime } from "@opencode-ai/core/capability/runtime"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { Effect, Exit, Layer } from "effect"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"

export type Tool = CoreCapabilityRuntime.Tool

export function tools(reference: CoreCapabilityRuntime.Reference): ReadonlyArray<Tool> {
  return reference.value?.tools ?? []
}

const layer = Layer.effect(
  CoreCapabilityRuntime.Service,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const runtimes = yield* InstanceState.make(
      Effect.fn("CapabilityRuntime.state")(function* () {
        const bridge = yield* EffectBridge.make()
        const owners = new Map<string, MCP.Registration>()

        return yield* CoreCapabilityRuntime.make({
          start: (key, definition) => {
            const server = serverName(key)
            let registration: MCP.Registration | undefined
            const cleanup = Effect.gen(function* () {
              if (!registration) return
              for (const [name, owner] of owners) if (owner === registration) owners.delete(name)
              yield* mcp.remove(registration).pipe(Effect.catchTag("MCP.NotFoundError", () => Effect.void))
            })
            return Effect.gen(function* () {
              if (definition.type !== "mcp") throw new Error(`Unsupported capability runtime type: ${definition.type}`)
              if (runtimeID(key) !== definition.id) throw new Error(`Capability runtime key does not match: ${key}`)
              if (yield* mcp.connection(server)) throw new Error(`MCP server name is already registered: ${server}`)
              const existing = new Set(Object.keys(yield* mcp.tools()))
              const added = yield* mcp.add(server, mcpConfig(definition), { hidden: true })
              const owned = added.registration
              registration = owned
              const connection = "status" in added.status ? added.status : added.status[server]
              if (connection?.status !== "connected") {
                throw new Error(
                  connection?.status === "failed"
                    ? connection.error
                    : `MCP server did not connect (${connection?.status ?? "unknown"})`,
                )
              }

              const upstream = yield* mcp.definitions(server)
              const names = upstream.map((definition) =>
                CapabilityManifest.canonicalName(
                  packID(key),
                  runtimeID(key),
                  McpCatalog.sanitize(definition.upstreamName),
                ),
              )
              const collision = names.find(
                (name, index) =>
                  names.indexOf(name) !== index ||
                  existing.has(name) ||
                  (owners.has(name) && owners.get(name) !== owned),
              )
              if (collision) {
                throw new Error(`Canonical tool name collision: ${collision}`)
              }
              for (const name of names) owners.set(name, owned)

              const definitions = Object.freeze(
                upstream.map((definition, index) =>
                  Object.freeze({
                    name: names[index]!,
                    description: definition.description,
                    inputSchema: definition.inputSchema,
                    call: definition.call,
                  }),
                ),
              )
              const stop = bridge.run(
                Effect.gen(function* () {
                  for (const name of names) if (owners.get(name) === owned) owners.delete(name)
                  yield* mcp.remove(owned).pipe(Effect.catchTag("MCP.NotFoundError", () => Effect.void))
                }),
              )

              return {
                value: Object.freeze({ tools: definitions }),
                stop,
                exited: bridge.run(waitForExit(mcp, owned)),
              }
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
  deps: [MCP.node],
})

function mcpConfig(definition: CapabilityManifest.Runtime): ConfigMCPV1.Info {
  const [command, ...args] = definition.command
  if (!command) throw new Error(`Capability runtime command is empty: ${definition.id}`)
  if (definition.command.length === 1 && URL.canParse(command)) {
    return {
      type: "remote",
      url: command,
      oauth: false,
      timeout: definition.timeoutMs,
    }
  }
  return {
    type: "local",
    command: [command, ...args],
    environment: definition.environment ? { ...definition.environment } : undefined,
    timeout: definition.timeoutMs,
  }
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
  return key.slice(index + 1)
}

function waitForExit(mcp: MCP.Interface, registration: MCP.Registration): Effect.Effect<void> {
  return Effect.gen(function* () {
    while ((yield* mcp.connection(registration))?.status === "connected") yield* Effect.sleep("1 second")
  })
}
