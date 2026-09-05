export * as CapabilityManager from "./manager"

import { Context, Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { CapabilityCatalog } from "@opencode-ai/core/capability/catalog"
import { CapabilityTool } from "@opencode-ai/core/tool/capability"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { LocationServiceMap, locationServiceMapNode } from "@/location-services"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import { CapabilityStore } from "./store"
import { CapabilitySchema } from "./schema"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { Schema } from "effect"

const make = Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  const sessions = yield* Session.Service
  const mcp = yield* MCP.Service
  const configService = yield* Config.Service
  const store = Effect.map(InstanceState.directory, (directory) =>
    CapabilityStore.make({ globalDirectory: Global.Path.config, projectDirectory: directory }),
  )
  const io = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (error) =>
        error instanceof CapabilitySchema.Error
          ? error
          : new CapabilitySchema.Error({ message: "Manager operation failed; check file access and configuration" }),
    })
  const located = <A, E>(operation: Effect.Effect<A, E, LocationServices>, sessionID?: SessionSchema.ID) =>
    Effect.gen(function* () {
      const context = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      if (sessionID) {
        const session = yield* sessions
          .get(SessionID.make(sessionID))
          .pipe(Effect.mapError(() => new CapabilitySchema.Error({ message: "Session not found" })))
        if (session.directory !== context.directory || session.workspaceID !== workspaceID)
          return yield* new CapabilitySchema.Error({ message: "Session does not belong to this location" })
      }
      return yield* operation.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make(context.directory), workspaceID })),
        ),
      )
    })
  const ready = Effect.gen(function* () {
    const plugins = yield* PluginV2.Service
    yield* plugins.wait(PluginV2.ID.make("capability"))
    return yield* CapabilityTool.Service
  })
  const resolved = (name: string, scope?: typeof CapabilitySchema.Scope.Type) =>
    Effect.gen(function* () {
      const storage = yield* store
      const found = yield* io(() => storage.resolve(name))
      if (scope && found.scope !== scope)
        return yield* new CapabilitySchema.Error({
          message: "This MCP is shadowed by project configuration; select the effective project MCP",
        })
      // Reload through the canonical resolver: inherited headers/environment and
      // custom, ancestor, organization and managed precedence remain authoritative.
      const effective = yield* configService.get({ refresh: true })
      return yield* Schema.decodeUnknownEffect(ConfigMCPV1.Info)(effective.mcp?.[name]).pipe(
        Effect.mapError(() => new CapabilitySchema.Error({ message: "Configured MCP definition is invalid" })),
      )
    })
  const synchronize = (name: string) =>
    Effect.gen(function* () {
      const config = yield* resolved(name)
      yield* mcp.add(name, config, {
        hidden: config.exposure === "pack-only",
        connect: config.exposure !== "pack-only" && config.enabled !== false,
      })
      yield* located(
        Effect.gen(function* () {
          const manager = yield* ready
          yield* manager.refresh(name)
        }),
      )
    })

  const list = Effect.fn("CapabilityManager.list")(function* (sessionID?: SessionSchema.ID) {
    const storage = yield* store
    const inventory = yield* io(() => storage.inventory())
    const status = yield* mcp.status()
    const packs = yield* located(
      Effect.gen(function* () {
        const manager = yield* ready
        const catalog = yield* CapabilityCatalog.Service
        const health = yield* manager.status(sessionID, { probe: false })
        const installed = yield* catalog.list()
        const entries = yield* Effect.forEach(installed, (pack) =>
          Effect.gen(function* () {
            const current = health.capabilities.find((entry) => entry.id === pack.id)
            return {
              id: pack.id,
              description: pack.description,
              source: pack.source,
              revision:
                pack.source === "builtin"
                  ? ""
                  : yield* io(() => storage.packRevision(pack.source as "global" | "project", pack.id)),
              profiles: Object.entries(pack.profiles).map(([id, profile]) => ({
                id,
                description: profile.description,
                platforms: profile.platforms ?? pack.platforms,
              })),
              active: (current?.profiles.length ?? 0) > 0,
              selectedProfiles: current?.profiles ?? [],
              state: current?.state ?? "installed",
              remediation: current?.remediation ?? [],
            }
          }),
        )
        return [
          ...entries,
          ...health.capabilities
            .filter((entry) => !installed.some((pack) => pack.id === entry.id))
            .map((entry) => ({
              id: entry.id,
              description: "The installed manifest is unavailable",
              source: "unavailable" as const,
              revision: "",
              profiles: [],
              active: true,
              selectedProfiles: entry.profiles,
              state: entry.state,
              remediation: entry.remediation,
            })),
        ]
      }),
      sessionID,
    )
    return {
      ...inventory,
      packs,
      mcps: inventory.mcps.map((entry) => ({
        ...entry,
        status:
          entry.scope === "global" &&
          inventory.mcps.some((other) => other.scope === "project" && other.name === entry.name)
            ? "shadowed"
            : (status[entry.name]?.status ?? "disabled"),
      })),
    }
  })
  const enable = Effect.fn("CapabilityManager.enable")(function* (
    input: Parameters<CapabilityTool.Interface["enable"]>[0],
  ) {
    return yield* located(
      Effect.gen(function* () {
        const manager = yield* ready
        return yield* manager.enable(input)
      }),
      input.sessionID,
    ).pipe(Effect.mapError((error) => new CapabilitySchema.Error({ message: error.message })))
  })
  const disable = Effect.fn("CapabilityManager.disable")(function* (
    input: Parameters<CapabilityTool.Interface["disable"]>[0],
  ) {
    return yield* located(
      Effect.gen(function* () {
        const manager = yield* ready
        return yield* manager.disable(input)
      }),
      input.sessionID,
    )
  })
  const saveMcp = Effect.fn("CapabilityManager.saveMcp")(function* (input: typeof CapabilitySchema.Save.Type) {
    const storage = yield* store
    const saved = yield* io(() => storage.save(input))
    if ((yield* io(() => storage.resolve(input.name))).scope !== input.scope) return { ...saved, status: "shadowed" }
    yield* synchronize(input.name)
    return { ...saved, status: (yield* mcp.connection(input.name))?.status ?? "disabled" }
  })
  const attachMcp = Effect.fn("CapabilityManager.attachMcp")(function* (input: typeof CapabilitySchema.Attach.Type) {
    const storage = yield* store
    const result = yield* io(() => storage.attach(input))
    yield* synchronize(input.name)
    return result
  })
  const checkMcp = Effect.fn("CapabilityManager.checkMcp")(function* (input: {
    name: string
    scope?: typeof CapabilitySchema.Scope.Type
  }) {
    const config = yield* resolved(input.name, input.scope)
    const name = `__manager_check_${crypto.randomUUID().replaceAll("-", "")}`
    return yield* Effect.acquireUseRelease(
      mcp.add(
        name,
        { ...config, enabled: true, timeout: Math.min(config.timeout ?? 5000, 15000) },
        { hidden: true, authName: input.name },
      ),
      (added) =>
        Effect.gen(function* () {
          const status = yield* mcp.connection(added.registration)
          const state =
            status?.status === "connected"
              ? ("connected" as const)
              : status?.status === "needs_auth" || status?.status === "needs_client_registration"
                ? ("needs_auth" as const)
                : ("failed" as const)
          return {
            name: input.name,
            state,
            tools: state === "connected" ? (yield* mcp.definitions(name)).map((tool) => tool.upstreamName) : [],
            remediation:
              state === "connected"
                ? []
                : state === "needs_auth"
                  ? ["Authenticate this MCP server, then check the connection again."]
                  : ["Check the command, URL and configured credentials, then retry."],
          }
        }),
      (added) => mcp.remove(added.registration).pipe(Effect.catchTag("MCP.NotFoundError", () => Effect.void)),
    )
  })
  return { list, enable, disable, saveMcp, checkMcp, attachMcp }
})

export class Service extends Context.Service<Service, Effect.Success<typeof make>>()("@opencode/CapabilityManager") {}
export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [locationServiceMapNode, Session.node, MCP.node, Config.node],
})
