import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import type { ChildProcess } from "effect/unstable/process"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CapabilityCatalog } from "@opencode-ai/core/capability/catalog"
import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { CapabilityRuntime } from "@opencode-ai/core/capability/runtime"
import { CapabilityState } from "@opencode-ai/core/capability/state"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { AppProcess } from "@opencode-ai/core/process"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { CapabilityTool } from "@opencode-ai/core/tool/capability"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { executeTool } from "./lib/tool"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_capability_tool")
const identity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_capability_tool"),
}

const pack = (index: number): CapabilityCatalog.Pack => ({
  id: CapabilityManifest.ID.make(index === 0 ? "browser" : `browser-${index}`),
  version: 1,
  description: `Browser capability ${index}`,
  platforms: ["darwin", "linux"],
  source: "builtin",
  directory: AbsolutePath.make(`/capabilities/browser-${index}`),
  skills: [
    {
      name: CapabilityManifest.ID.make(index === 0 ? "browser-testing" : `browser-testing-${index}`),
      description: "Verify browser outcomes",
      path: "SKILL.md",
      location: AbsolutePath.make(`/capabilities/browser-${index}/SKILL.md`),
      content: "# Browser testing",
    },
  ],
  runtimes: [
    CapabilityManifest.Runtime.make({
      id: CapabilityManifest.ID.make("playwright"),
      type: "mcp",
      command: ["playwright"],
      tools: ["navigate"],
      optional: false,
      timeoutMs: 15_000,
    }),
  ],
  profiles: {
    [CapabilityManifest.ID.make("default")]: {
      description: "Interact with browser pages",
      skills: [CapabilityManifest.ID.make(index === 0 ? "browser-testing" : `browser-testing-${index}`)],
      runtimes: [CapabilityManifest.ID.make("playwright")],
    },
  },
  dependencies: [
    {
      id: CapabilityManifest.ID.make("node"),
      check: ["node", "--version"],
      optional: false,
    },
  ],
})

const mobilePack = (): CapabilityCatalog.Pack => ({
  id: CapabilityManifest.ID.make("mobile"),
  version: 1,
  description: "Inspect mobile applications",
  platforms: ["darwin", "linux"],
  source: "builtin",
  directory: AbsolutePath.make("/capabilities/mobile"),
  skills: [
    {
      name: CapabilityManifest.ID.make("mobile-testing"),
      description: "Inspect mobile applications",
      path: "mobile.md",
      location: AbsolutePath.make("/capabilities/mobile/mobile.md"),
      content: "# Mobile",
    },
  ],
  runtimes: [],
  profiles: {
    [CapabilityManifest.ID.make("ios")]: {
      description: "Inspect iOS applications",
      skills: [CapabilityManifest.ID.make("mobile-testing")],
      runtimes: [],
      platforms: ["darwin"],
    },
    [CapabilityManifest.ID.make("android")]: {
      description: "Inspect Android applications",
      skills: [CapabilityManifest.ID.make("mobile-testing")],
      runtimes: [],
      platforms: ["darwin", "linux"],
    },
  },
  dependencies: [
    {
      id: CapabilityManifest.ID.make("xcodebuild"),
      check: ["xcodebuild", "-version"],
      optional: true,
      profiles: [CapabilityManifest.ID.make("ios")],
    },
    {
      id: CapabilityManifest.ID.make("xcrun"),
      check: ["xcrun", "simctl", "list", "-j"],
      optional: true,
      profiles: [CapabilityManifest.ID.make("ios")],
    },
    {
      id: CapabilityManifest.ID.make("flutter"),
      check: ["flutter", "--version"],
      optional: true,
      profiles: [CapabilityManifest.ID.make("ios"), CapabilityManifest.ID.make("android")],
    },
    {
      id: CapabilityManifest.ID.make("adb"),
      check: ["adb", "version"],
      optional: true,
      profiles: [CapabilityManifest.ID.make("android")],
    },
  ],
})

const packs = Array.from({ length: 12 }, (_, index) => pack(index))
let catalogPacks = packs
const activations = new Map<SessionV2.ID, CapabilityState.Activation[]>()
const events: string[] = []
let runtimeFailure = false
let runtimeState: CapabilityRuntime.Status["state"] = "healthy"
let diagnostic = ""
let runtimeCalls = 0
let denyRuntime = false
let deniedResource: string | undefined
let probeExitCode = 0
const probeFailures = new Set<string>()
const probeCommands: string[] = []
let runtimeReferences:
  | ((definitions: ReadonlyArray<CapabilityRuntime.ActivationInput>) => ReadonlyArray<CapabilityRuntime.Reference>)
  | undefined
let agentPermissions: PermissionV2.Ruleset = []
let permissionRequests: PermissionV2.AssertInput[] = []
let deletedSessions = new Set<SessionV2.ID>()
let pausedList:
  | {
      readonly sessionID: SessionV2.ID
      readonly started: Deferred.Deferred<void>
      readonly resume: Deferred.Deferred<void>
    }
  | undefined
let catalogGetCalls = 0
let activationTrace: string[] = []

const catalog = CapabilityCatalog.Service.of({
  list: () => Effect.succeed(catalogPacks),
  get: (id) =>
    Effect.sync(() => {
      catalogGetCalls++
      activationTrace.push("catalog:get")
      return catalogPacks.find((item) => item.id === id)
    }),
  search: (_query, active) =>
    Effect.succeed([
      ...catalogPacks.filter((item) => !active.has(item.id)),
      ...catalogPacks.filter((item) => active.has(item.id)),
    ]),
  register: () => Effect.void,
})

const state = CapabilityState.Service.of({
  list: (id) =>
    Effect.gen(function* () {
      const snapshot = activations.get(id) ?? []
      const pause = pausedList
      if (pause?.sessionID === id) {
        pausedList = undefined
        yield* Deferred.succeed(pause.started, undefined)
        yield* Deferred.await(pause.resume)
      }
      return snapshot
    }),
  enable: (input) =>
    Effect.sync(() => {
      events.push("persist:enable")
      activations.set(input.sessionID, [
        { id: input.id, profiles: [...input.profiles], state: input.state ?? "active" },
      ])
    }),
  disable: (input) =>
    Effect.sync(() => {
      events.push("persist:disable")
      activations.set(
        input.sessionID,
        (activations.get(input.sessionID) ?? []).filter((item) => item.id !== input.id),
      )
    }),
  status: (id) => Effect.succeed(activations.get(id) ?? []),
})

const makeReference = (key: string, runtimeName = "playwright") =>
  ({
    key,
    available: true,
    value: {
      tools: [
        {
          name: "browser_playwright_navigate",
          description: "Navigate to a page",
          inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
            additionalProperties: false,
          },
          call: (input: unknown) =>
            Effect.sync(() => {
              runtimeCalls++
              return { runtime: runtimeName, navigated: input }
            }),
        },
      ],
    },
  }) as unknown as CapabilityRuntime.Reference

const reference = makeReference("browser/playwright")

const activatedKeys: string[] = []
const releasedKeys: string[] = []

const runtime = CapabilityRuntime.Service.of({
  acquire: (key, definition) => Effect.succeed(makeReference(key, definition.command?.[0])),
  release: (released) =>
    Effect.sync(() => {
      events.push("runtime:release")
      releasedKeys.push(released.key)
    }),
  activate: (definitions) =>
    Effect.sync(() => {
      events.push("runtime:activate")
      activatedKeys.push(...definitions.map((definition) => definition.key))
      return runtimeFailure
        ? ({ state: "failed", references: [], diagnostic: "startup failed" } as const)
        : ({
            state: "active",
            references:
              runtimeReferences?.(definitions) ??
              definitions.map(({ key, definition }) => makeReference(key, definition.command?.[0] ?? definition.id)),
          } as const)
    }),
  status: () =>
    Effect.succeed({
      state: runtimeState,
      references: activations.has(sessionID) ? 1 : 0,
      updatedAt: 1_788_480_000_000,
      ...(diagnostic ? { diagnostic } : {}),
    }),
})

const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: (command: ChildProcess.Command) =>
      Effect.sync(() => {
        events.push("probe")
        const rendered = command._tag === "StandardCommand" ? [command.command, ...command.args].join(" ") : "probe"
        probeCommands.push(rendered)
        return {
          command: command._tag === "StandardCommand" ? command.command : "probe",
          exitCode: probeFailures.has(rendered) ? 1 : probeExitCode,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          stdoutTruncated: false,
          stderrTruncated: false,
        }
      }),
  } as unknown as AppProcess.Interface),
)
const permission = Layer.mock(PermissionV2.Service, {
  assert: (input) =>
    Effect.sync(() => {
      permissionRequests.push(input)
      events.push(`permission:${input.action}`)
    }).pipe(
      Effect.andThen(
        denyRuntime || (deniedResource !== undefined && input.resources.includes(deniedResource))
          ? Effect.fail(new PermissionV2.BlockedError({ rules: [] }))
          : Effect.void,
      ),
    ),
})

const agent = Layer.mock(AgentV2.Service, {
  resolve: () =>
    Effect.succeed(
      AgentV2.Info.make({
        ...AgentV2.Info.empty(identity.agent),
        permissions: agentPermissions,
      }),
    ),
})

const sessions = Layer.mock(SessionStore.Service, {
  get: (id) => Effect.succeed(deletedSessions.has(id) ? undefined : ({ id } as SessionV2.Info)),
})

const layer = AppNodeBuilder.build(
  LayerNode.group([
    EventV2.node,
    ApplicationTools.node,
    ToolRegistry.node,
    ToolRegistry.toolsNode,
    CapabilityTool.node,
  ]),
  [
    [CapabilityCatalog.node, Layer.succeed(CapabilityCatalog.Service, catalog)],
    [CapabilityState.node, Layer.succeed(CapabilityState.Service, state)],
    [CapabilityRuntime.node, Layer.succeed(CapabilityRuntime.Service, runtime)],
    [AppProcess.node, appProcess],
    [PermissionV2.node, permission],
    [AgentV2.node, agent],
    [SessionStore.node, sessions],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ],
)
const it = testEffect(layer)

const reset = () => {
  catalogPacks = packs
  activations.clear()
  events.length = 0
  runtimeFailure = false
  runtimeState = "healthy"
  diagnostic = ""
  runtimeCalls = 0
  denyRuntime = false
  deniedResource = undefined
  probeExitCode = 0
  probeFailures.clear()
  probeCommands.length = 0
  runtimeReferences = undefined
  activatedKeys.length = 0
  releasedKeys.length = 0
  agentPermissions = []
  permissionRequests = []
  deletedSessions = new Set()
  pausedList = undefined
  catalogGetCalls = 0
  activationTrace = []
}

const names = (materialized: ToolRegistry.Materialization) =>
  materialized.definitions.map((definition) => definition.name).toSorted()

const call = (name: string, input: unknown) =>
  executeTool(yieldRegistry, {
    sessionID,
    ...identity,
    call: { type: "tool-call", id: `call-${name}`, name, input },
  })

const callForSession = (currentSessionID: SessionV2.ID, name: string, input: unknown) =>
  executeTool(yieldRegistry, {
    sessionID: currentSessionID,
    ...identity,
    call: { type: "tool-call", id: `call-${currentSessionID}-${name}`, name, input },
  })

let yieldRegistry: ToolRegistry.Interface

describe("CapabilityTool", () => {
  it.effect("refreshing a configured MCP invalidates the held runtime at the next materialization", () =>
    Effect.gen(function* () {
      reset()
      catalogPacks = [{ ...pack(0), runtimes: [{ ...pack(0).runtimes[0], command: [], mcp: "configured" }] }]
      yieldRegistry = yield* ToolRegistry.Service
      const manager = yield* CapabilityTool.Service
      yield* manager.enable({ sessionID, id: CapabilityManifest.ID.make("browser") })
      const previous = [...activatedKeys]
      yield* manager.refresh("configured")
      yield* yieldRegistry.materialize(sessionID)
      expect(activatedKeys).toHaveLength(2)
      expect(activatedKeys[1]).not.toBe(previous[0])
      expect(releasedKeys).toContain(previous[0])
    }),
  )

  it.effect("a referenced MCP retains its original permission resource at execution", () =>
    Effect.gen(function* () {
      reset()
      runtimeReferences = (definitions) =>
        definitions.map(({ key }) => {
          const reference = makeReference(key)
          return {
            ...reference,
            value: {
              tools: reference.value!.tools.map((tool) => ({
                ...tool,
                permission: { action: "configured_navigate", resource: "mcp:configured:configured_navigate" },
              })),
            },
          }
        })
      yieldRegistry = yield* ToolRegistry.Service
      yield* call("capability_enable", { id: "browser" })
      deniedResource = "mcp:configured:configured_navigate"
      const result = yield* call("browser_playwright_navigate", { url: "https://example.com" })
      expect(result).toMatchObject({ type: "error" })
      expect(runtimeCalls).toBe(0)
    }),
  )

  it.effect("human management shares lifecycle and session isolation without a tool invocation", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      const manager = yield* CapabilityTool.Service
      const other = SessionV2.ID.make("ses_human_other")
      expect(yield* manager.enable({ sessionID, id: CapabilityManifest.ID.make("browser") })).toMatchObject({
        state: "active",
        nextTurn: true,
      })
      expect(names(yield* yieldRegistry.materialize(sessionID))).toContain("browser_playwright_navigate")
      expect(names(yield* yieldRegistry.materialize(other))).not.toContain("browser_playwright_navigate")
      expect(permissionRequests).toEqual([])
      const advertised = yield* yieldRegistry.materialize(sessionID)
      yield* manager.disable({ sessionID, id: CapabilityManifest.ID.make("browser") })
      expect(events).not.toContain("runtime:release")
      expect(
        yield* advertised.settle({
          sessionID,
          ...identity,
          call: {
            type: "tool-call",
            id: "call-before-disable",
            name: "browser_playwright_navigate",
            input: { url: "https://example.com" },
          },
        }),
      ).toMatchObject({ result: { type: "json" } })
      expect(names(yield* yieldRegistry.materialize(sessionID))).not.toContain("browser_playwright_navigate")
      expect(events).toContain("runtime:release")
    }),
  )

  it.effect("read-only manager inventory skips dependency probes and retains runtime remediation", () =>
    Effect.gen(function* () {
      reset()
      const manager = yield* CapabilityTool.Service
      expect((yield* manager.status(undefined, { probe: false })).capabilities[0].state).toBe("installed")
      expect(probeCommands).toEqual([])
      yield* manager.enable({ sessionID, id: CapabilityManifest.ID.make("browser") })
      probeCommands.length = 0
      runtimeState = "failed"
      const inventory = yield* manager.status(sessionID, { probe: false })
      expect(inventory.capabilities[0]).toMatchObject({
        state: "failed",
        remediation: expect.arrayContaining([expect.stringContaining("browser")]),
      })
      expect(probeCommands).toEqual([])
      yield* manager.status(sessionID)
      expect(probeCommands).not.toEqual([])
    }),
  )

  test("declares the host capability runtime adapter as an unbound requirement", () => {
    expect(LayerNode.hasUnbound(CapabilityTool.node, CapabilityRuntime.node)).toBe(true)
  })

  it.effect("advertises exactly four capability management tools by default", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service

      expect(
        names(yield* yieldRegistry.materialize(sessionID)).filter((name) => name.startsWith("capability_")),
      ).toEqual(["capability_disable", "capability_enable", "capability_search", "capability_status"])
    }),
  )

  it.effect("limits search to ten ranked summaries", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service

      expect(yield* call("capability_search", { query: "browser testing" })).toMatchObject({
        type: "json",
        value: {
          capabilities: expect.arrayContaining([
            expect.objectContaining({ id: "browser", active: false, compatible: true }),
          ]),
        },
      })
      const result = yield* call("capability_search", { query: "browser testing" })
      expect(result.type).toBe("json")
      if (result.type === "json") {
        expect((result.value as { capabilities: unknown[] }).capabilities).toHaveLength(10)
      }
      const searchPermission = permissionRequests.at(-1)
      expect({
        action: searchPermission?.action,
        resources: searchPermission?.resources,
        save: searchPermission?.save,
      }).toEqual({ action: "capability_search", resources: ["browser testing"], save: ["browser testing"] })
    }),
  )

  it.effect("authorizes capability status without offering wildcard persistence", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service

      yield* call("capability_status", { id: "browser" })
      const one = permissionRequests.at(-1)
      expect({ action: one?.action, resources: one?.resources, save: one?.save }).toEqual({
        action: "capability_status",
        resources: ["browser"],
        save: ["browser"],
      })

      yield* call("capability_status", {})
      const all = permissionRequests.at(-1)
      expect({ action: all?.action, resources: all?.resources, save: all?.save }).toEqual({
        action: "capability_status",
        resources: ["*"],
        save: undefined,
      })
    }),
  )

  it.effect("enables atomically and returns tools and skills available on the next materialization", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      expect(names(yield* yieldRegistry.materialize(sessionID))).not.toContain("browser_playwright_navigate")

      expect(yield* call("capability_enable", { id: "browser", profiles: ["default"] })).toMatchObject({
        type: "json",
        value: {
          id: "browser",
          profiles: ["default"],
          state: "active",
          nextTurn: true,
          tools: ["browser_playwright_navigate"],
          skills: ["browser-testing"],
          availableTools: ["browser_playwright_navigate"],
          availableSkills: ["browser-testing"],
          permissionFiltered: true,
        },
      })
      expect(events.slice(0, 4)).toEqual([
        "permission:capability_enable",
        "probe",
        "runtime:activate",
        "persist:enable",
      ])
      expect(permissionRequests[0]).toMatchObject({
        action: "capability_enable",
        resources: ["browser"],
        save: ["browser"],
      })

      const materialized = yield* yieldRegistry.materialize(sessionID)
      expect(names(materialized)).toContain("browser_playwright_navigate")
      expect(materialized.definitions.find((item) => item.name === "browser_playwright_navigate")?.inputSchema).toEqual(
        reference.value?.tools[0]?.inputSchema as Record<string, unknown>,
      )
      expect(
        yield* materialized.settle({
          sessionID,
          ...identity,
          call: {
            type: "tool-call",
            id: "call-browser-navigate",
            name: "browser_playwright_navigate",
            input: { url: "https://example.com" },
          },
        }),
      ).toMatchObject({ result: { type: "json", value: { navigated: { url: "https://example.com" } } } })
      expect(events).toContain("permission:browser_playwright_navigate")
      expect(permissionRequests.at(-1)).toMatchObject({
        resources: ["mcp:playwright:browser_playwright_navigate", "https://example.com"],
        save: ["mcp:playwright:browser_playwright_navigate"],
      })
      expect(permissionRequests.at(-1)?.resources).not.toContain("*")
      expect(permissionRequests.at(-1)?.save).not.toContain("*")
      expect(runtimeCalls).toBe(1)

      denyRuntime = true
      expect(
        yield* (yield* yieldRegistry.materialize(sessionID)).settle({
          sessionID,
          ...identity,
          call: {
            type: "tool-call",
            id: "call-browser-denied",
            name: "browser_playwright_navigate",
            input: { url: "https://example.com/private" },
          },
        }),
      ).toMatchObject({ result: { type: "error", value: "Permission denied: browser_playwright_navigate" } })
      expect(runtimeCalls).toBe(1)
    }),
  )

  it.effect("emits activation outcomes without inputs, session identity, or runtime diagnostics", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      const eventBus = yield* EventV2.Service
      const observed: EventV2.Payload[] = []
      const unsubscribe = yield* eventBus.listen((event) =>
        Effect.sync(() => {
          if (event.type === "capability.startup.measured" || event.type.startsWith("capability.activation.")) {
            observed.push(event)
          }
        }),
      )

      yield* call("capability_enable", { id: "browser", profile: "default", token: "input-secret" })
      yield* call("capability_disable", { id: "browser" })
      runtimeFailure = true
      diagnostic = "private runtime failure at https://private-host.invalid/path"
      yield* call("capability_enable", { id: "browser", profile: "default" })
      denyRuntime = true
      yield* call("capability_enable", { id: "browser-1", profile: "default" })
      yield* unsubscribe

      expect(
        observed.filter((event) => event.type.startsWith("capability.activation.")).map((event) => event.type),
      ).toEqual([
        "capability.activation.requested",
        "capability.activation.succeeded",
        "capability.activation.requested",
        "capability.activation.failed",
        "capability.activation.requested",
        "capability.activation.failed",
      ])
      expect(observed.filter((event) => event.type === "capability.startup.measured")).toHaveLength(3)
      const serialized = JSON.stringify(observed)
      expect(serialized).not.toContain(sessionID)
      expect(serialized).not.toContain("input-secret")
      expect(serialized).not.toContain("private-host")
      expect(
        observed.every((event) =>
          Object.keys(event.data as Readonly<Record<string, unknown>>).every((key) => key !== "profiles"),
        ),
      ).toBe(true)
    }),
  )

  it.effect("requests activation before one catalog read and counts only selected profile runtimes", () =>
    Effect.gen(function* () {
      reset()
      const browser = pack(0)
      const unusedRuntime = CapabilityManifest.Runtime.make({
        id: CapabilityManifest.ID.make("unused-runtime"),
        type: "mcp",
        command: ["unused-runtime"],
        tools: ["unused"],
        optional: false,
        timeoutMs: 15_000,
      })
      catalogPacks = [
        {
          ...browser,
          runtimes: [...browser.runtimes, unusedRuntime],
          profiles: {
            ...browser.profiles,
            [CapabilityManifest.ID.make("unused")]: {
              description: "Unused profile",
              skills: [],
              runtimes: [unusedRuntime.id],
            },
          },
        },
      ]
      yieldRegistry = yield* ToolRegistry.Service
      const eventBus = yield* EventV2.Service
      const observed: EventV2.Payload[] = []
      const unsubscribe = yield* eventBus.listen((event) =>
        Effect.sync(() => {
          if (event.type === "capability.activation.requested") activationTrace.push("activation:requested")
          if (event.type === "capability.startup.measured") observed.push(event)
        }),
      )

      yield* call("capability_enable", { id: "browser", profile: "default" })
      yield* unsubscribe

      expect(activationTrace).toEqual(["activation:requested", "catalog:get"])
      expect(catalogGetCalls).toBe(1)
      expect(observed).toHaveLength(1)
      expect(observed[0]?.data).toMatchObject({ runtimeCount: 1 })
    }),
  )

  it.effect("treats an empty requested profile list as default without enabling diagnostics", () =>
    Effect.gen(function* () {
      reset()
      const browser = pack(0)
      const diagnostics = CapabilityManifest.ID.make("diagnostics")
      const devtools = CapabilityManifest.ID.make("chrome-devtools")
      catalogPacks = [
        {
          ...browser,
          runtimes: [
            ...browser.runtimes,
            CapabilityManifest.Runtime.make({
              id: devtools,
              type: "mcp",
              command: ["chrome-devtools"],
              tools: ["console"],
              optional: false,
            }),
          ],
          profiles: {
            ...browser.profiles,
            [diagnostics]: {
              description: "Inspect browser diagnostics",
              skills: [],
              runtimes: [devtools],
            },
          },
        },
      ]
      yieldRegistry = yield* ToolRegistry.Service

      const omittedSession = SessionV2.ID.make("ses_capability_tool_omitted_profiles")
      const omitted = yield* callForSession(omittedSession, "capability_enable", { id: "browser" })
      const empty = yield* call("capability_enable", { id: "browser", profiles: [] })
      expect(empty).toEqual(omitted)
      expect(empty).toMatchObject({
        type: "json",
        value: {
          id: "browser",
          profiles: ["default"],
          state: "active",
          tools: ["browser_playwright_navigate"],
        },
      })
      expect(activations.get(sessionID)).toEqual([{ id: "browser", profiles: ["default"], state: "active" }])
      expect(activations.get(omittedSession)).toEqual([{ id: "browser", profiles: ["default"], state: "active" }])
      expect(activatedKeys).toHaveLength(2)
      expect(activatedKeys.every((key) => key.startsWith("browser/playwright#"))).toBe(true)

      expect(yield* call("capability_enable", { id: "browser", profiles: ["unknown"] })).toMatchObject({
        type: "error",
        value: "Capability profile not found: browser/unknown",
      })
      expect(
        yield* call("capability_enable", { id: "browser", profiles: Array.from({ length: 17 }, () => "default") }),
      ).toMatchObject({ type: "error", value: expect.stringContaining("Invalid tool input") })
      expect(activations.get(sessionID)).toEqual([{ id: "browser", profiles: ["default"], state: "active" }])
    }),
  )

  it.effect("accepts a provider-stable singular profile and rejects ambiguous or conflicting aliases", () =>
    Effect.gen(function* () {
      reset()
      catalogPacks = [mobilePack()]
      yieldRegistry = yield* ToolRegistry.Service

      const definition = (yield* yieldRegistry.materialize(sessionID)).definitions.find(
        (item) => item.name === "capability_enable",
      )
      const schema = definition?.inputSchema as { properties?: Record<string, unknown> } | undefined
      expect(Object.keys(schema?.properties ?? {}).toSorted()).toEqual(["id", "profile", "profiles"])
      expect(JSON.stringify(schema?.properties?.profile)).toContain('"type":"string"')
      expect(JSON.stringify(schema?.properties?.profiles)).toContain('"type":"array"')

      yield* withPlatform(
        "darwin",
        Effect.gen(function* () {
          expect(yield* call("capability_enable", { id: "mobile", profile: "ios", profiles: [] })).toMatchObject({
            type: "json",
            value: { id: "mobile", profiles: ["ios"], state: "active" },
          })
          expect(activations.get(sessionID)).toEqual([{ id: "mobile", profiles: ["ios"], state: "active" }])

          const probesBeforeConflict = probeCommands.length
          expect(
            yield* call("capability_enable", { id: "mobile", profile: "ios", profiles: ["android"] }),
          ).toMatchObject({
            type: "error",
            value: "Conflicting capability profile aliases: profile=ios, profiles=android",
          })
          expect(probeCommands).toHaveLength(probesBeforeConflict)
          expect(activations.get(sessionID)).toEqual([{ id: "mobile", profiles: ["ios"], state: "active" }])
        }),
      )

      const ambiguousSession = SessionV2.ID.make("ses_capability_tool_ambiguous_profiles")
      expect(
        yield* callForSession(ambiguousSession, "capability_enable", { id: "mobile", profiles: [] }),
      ).toMatchObject({
        type: "error",
        value: "Capability mobile requires a profile. Available profiles: ios, android",
      })
      expect(activations.has(ambiguousSession)).toBe(false)

      const sole = CapabilityManifest.ID.make("solo")
      catalogPacks = [
        {
          ...mobilePack(),
          profiles: {
            [sole]: {
              description: "Only profile",
              skills: [CapabilityManifest.ID.make("mobile-testing")],
              runtimes: [],
              platforms: ["darwin"],
            },
          },
          dependencies: [],
        },
      ]
      const soleSession = SessionV2.ID.make("ses_capability_tool_sole_profile")
      yield* withPlatform(
        "darwin",
        Effect.gen(function* () {
          expect(yield* callForSession(soleSession, "capability_enable", { id: "mobile", profiles: [] })).toMatchObject(
            {
              type: "json",
              value: { profiles: ["solo"], state: "active" },
            },
          )
        }),
      )
    }),
  )

  it.effect("leaves an existing activation unchanged when required runtime acquisition fails", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      activations.set(sessionID, [{ id: "browser", profiles: ["default"], state: "active" }])
      runtimeFailure = true

      expect(yield* call("capability_enable", { id: "browser", profiles: ["default"] })).toMatchObject({
        type: "json",
        value: { state: "failed", nextTurn: false, remediation: expect.any(Array) },
      })
      expect(events.filter((event) => event === "persist:enable")).toEqual([])
      expect(activations.get(sessionID)).toEqual([{ id: "browser", profiles: ["default"], state: "active" }])
    }),
  )

  it.effect("releases acquired references and partial registrations when dynamic registration fails", () =>
    Effect.gen(function* () {
      reset()
      const invalidRuntime = CapabilityManifest.Runtime.make({
        id: CapabilityManifest.ID.make("invalid"),
        type: "mcp",
        command: ["invalid"],
        tools: ["invalid tool"],
        optional: false,
      })
      catalogPacks = [
        {
          ...pack(0),
          runtimes: [...pack(0).runtimes, invalidRuntime],
          profiles: {
            [CapabilityManifest.ID.make("default")]: {
              ...pack(0).profiles[CapabilityManifest.ID.make("default")]!,
              runtimes: [CapabilityManifest.ID.make("playwright"), CapabilityManifest.ID.make("invalid")],
            },
          },
        },
      ]
      const invalidReference = {
        key: "browser/invalid",
        available: true,
        value: {
          tools: [
            {
              name: "invalid tool",
              description: "Cannot be registered",
              inputSchema: { type: "object" },
              call: () => Effect.void,
            },
          ],
        },
      } as unknown as CapabilityRuntime.Reference
      runtimeReferences = (definitions) => [
        makeReference(definitions[0]!.key),
        { ...invalidReference, key: definitions[1]!.key } as unknown as CapabilityRuntime.Reference,
      ]
      yieldRegistry = yield* ToolRegistry.Service

      expect(yield* call("capability_enable", { id: "browser", profiles: ["default"] })).toMatchObject({
        type: "error",
        value: "Capability tools could not be registered: browser",
      })
      expect(events.filter((event) => event === "runtime:release")).toHaveLength(2)
      expect(events).not.toContain("persist:enable")
      expect(names(yield* yieldRegistry.materialize(sessionID))).not.toContain("browser_playwright_navigate")
    }),
  )

  it.effect("does not acquire or persist when a required dependency probe fails", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      probeExitCode = 1

      expect(yield* call("capability_enable", { id: "browser", profiles: ["default"] })).toMatchObject({
        type: "json",
        value: {
          state: "failed",
          nextTurn: false,
          dependencies: expect.arrayContaining([expect.objectContaining({ id: "node", state: "missing" })]),
          remediation: expect.arrayContaining([expect.stringContaining("node")]),
        },
      })
      expect(events).toEqual(["permission:capability_enable", "probe"])
      expect(activations.get(sessionID)).toBeUndefined()
    }),
  )

  it.effect("reacquires persisted active runtimes before advertising their tools", () =>
    Effect.gen(function* () {
      reset()
      activations.set(sessionID, [{ id: "browser", profiles: ["default"], state: "active" }])
      yieldRegistry = yield* ToolRegistry.Service

      expect(names(yield* yieldRegistry.materialize(sessionID))).toContain("browser_playwright_navigate")
      expect(events).toEqual(["probe", "runtime:activate"])
    }),
  )

  it.effect("serializes prepare with disable and re-reads activation under the capability lock", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      const management = yield* yieldRegistry.materialize(sessionID)
      activations.set(sessionID, [{ id: "browser", profiles: ["default"], state: "active" }])
      const started = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      pausedList = { sessionID, started, resume }

      const preparing = yield* yieldRegistry.materialize(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(
        yield* management.settle({
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "call-disable-race", name: "capability_disable", input: { id: "browser" } },
        }),
      ).toMatchObject({ result: { type: "json", value: { state: "disabled" } } })
      yield* Deferred.succeed(resume, undefined)
      expect(names(yield* Fiber.join(preparing))).not.toContain("browser_playwright_navigate")
      expect(events).not.toContain("runtime:activate")
    }),
  )

  it.effect("releases and withholds a held capability when its manifest is removed", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      yield* call("capability_enable", { id: "browser", profiles: ["default"] })
      catalogPacks = catalogPacks.filter((item) => item.id !== "browser")
      events.length = 0

      expect(names(yield* yieldRegistry.materialize(sessionID))).not.toContain("browser_playwright_navigate")
      expect(events).toContain("runtime:release")
    }),
  )

  it.effect(
    "releases and withholds a held capability when its manifest definition changes and reacquisition fails",
    () =>
      Effect.gen(function* () {
        reset()
        yieldRegistry = yield* ToolRegistry.Service
        yield* call("capability_enable", { id: "browser", profiles: ["default"] })
        catalogPacks = [
          {
            ...pack(0),
            runtimes: pack(0).runtimes.map((definition) =>
              CapabilityManifest.Runtime.make({ ...definition, command: ["changed-runtime"] }),
            ),
          },
        ]
        runtimeFailure = true
        events.length = 0

        expect(names(yield* yieldRegistry.materialize(sessionID))).not.toContain("browser_playwright_navigate")
        expect(events).toContain("runtime:release")
        expect(events).toContain("runtime:activate")
      }),
  )

  it.effect("keeps changed runtime and registration identities separate while another session holds the old pack", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      const sessionB = SessionV2.ID.make("ses_capability_tool_b")
      yield* callForSession(sessionB, "capability_enable", { id: "browser", profiles: ["default"] })
      const oldKey = activatedKeys.at(-1)!
      events.length = 0

      catalogPacks = [
        {
          ...pack(0),
          runtimes: pack(0).runtimes.map((definition) =>
            CapabilityManifest.Runtime.make({ ...definition, command: ["changed-runtime"] }),
          ),
        },
      ]
      yield* callForSession(sessionID, "capability_enable", { id: "browser", profiles: ["default"] })
      const newKey = activatedKeys.at(-1)!

      expect(newKey).not.toBe(oldKey)
      expect(releasedKeys).not.toContain(oldKey)
      const current = yield* yieldRegistry.materialize(sessionID)
      expect(
        yield* current.settle({
          sessionID,
          ...identity,
          call: {
            type: "tool-call",
            id: "call-new-runtime",
            name: "browser_playwright_navigate",
            input: { url: "https://example.com" },
          },
        }),
      ).toMatchObject({ result: { type: "json", value: { runtime: "changed-runtime" } } })

      yield* yieldRegistry.materialize(sessionB)
      expect(releasedKeys).toContain(oldKey)
    }),
  )

  it.effect("releases held references for cascade-deleted sessions on any later prepare", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      yield* call("capability_enable", { id: "browser", profiles: ["default"] })
      activations.delete(sessionID)
      deletedSessions.add(sessionID)
      events.length = 0

      yield* yieldRegistry.materialize(SessionV2.ID.make("ses_other"))
      expect(events).toContain("runtime:release")
    }),
  )

  it.effect("disables future schemas before releasing held runtime references", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      yield* call("capability_enable", { id: "browser", profiles: ["default"] })
      events.length = 0

      expect(yield* call("capability_disable", { id: "browser" })).toMatchObject({
        type: "json",
        value: { id: "browser", state: "disabled", nextTurn: true },
      })
      expect(events).toEqual(["permission:capability_disable", "persist:disable"])
      expect(permissionRequests.at(-1)).toMatchObject({
        action: "capability_disable",
        resources: ["browser"],
        save: ["browser"],
      })
      expect(names(yield* yieldRegistry.materialize(sessionID))).not.toContain("browser_playwright_navigate")
      expect(events).toContain("runtime:release")
    }),
  )

  it.effect("reports redacted actionable runtime health", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      yield* call("capability_enable", { id: "browser", profiles: ["default"] })
      runtimeState = "failed"
      diagnostic = "connection failed with secret-value"

      const result = yield* call("capability_status", { id: "browser" })
      expect(result).toMatchObject({
        type: "json",
        value: {
          capabilities: [
            expect.objectContaining({
              id: "browser",
              state: "failed",
              checkedAt: 1_788_480_000_000,
              remediation: expect.arrayContaining([expect.stringContaining("browser")]),
            }),
          ],
        },
      })
      expect(JSON.stringify(result)).not.toContain("secret-value")
    }),
  )

  it.effect("reports iOS unsupported on Linux while missing Android tools degrade only Android", () =>
    withPlatform(
      "linux",
      Effect.gen(function* () {
        reset()
        catalogPacks = [mobilePack()]
        probeFailures.add("adb version")
        yieldRegistry = yield* ToolRegistry.Service

        expect(yield* call("capability_status", { id: "mobile" })).toMatchObject({
          type: "json",
          value: {
            capabilities: [
              expect.objectContaining({
                id: "mobile",
                profileStatus: {
                  android: expect.objectContaining({
                    state: "degraded",
                    dependencies: expect.arrayContaining([
                      expect.objectContaining({ id: "adb", state: "optional-missing" }),
                    ]),
                  }),
                  ios: expect.objectContaining({
                    state: "unsupported",
                    dependencies: [],
                    remediation: expect.arrayContaining([expect.stringContaining("darwin")]),
                  }),
                },
              }),
            ],
          },
        })
        expect(probeCommands.toSorted()).toEqual(["adb version", "flutter --version"])

        probeCommands.length = 0
        expect(yield* call("capability_enable", { id: "mobile", profiles: ["ios"] })).toMatchObject({
          type: "json",
          value: { state: "unsupported", nextTurn: false },
        })
        expect(probeCommands).toEqual([])
        expect(activations.get(sessionID)).toBeUndefined()

        expect(yield* call("capability_enable", { id: "mobile", profiles: ["android"] })).toMatchObject({
          type: "json",
          value: {
            state: "degraded",
            profiles: ["android"],
            dependencies: expect.arrayContaining([expect.objectContaining({ id: "adb", state: "optional-missing" })]),
          },
        })
        expect(probeCommands.toSorted()).toEqual(["adb version", "flutter --version"])
        expect(activations.get(sessionID)).toEqual([{ id: "mobile", profiles: ["android"], state: "degraded" }])
      }),
    ),
  )

  it.effect("keeps an optional iOS probe failure out of Android profile health", () =>
    withPlatform(
      "darwin",
      Effect.gen(function* () {
        reset()
        catalogPacks = [mobilePack()]
        yieldRegistry = yield* ToolRegistry.Service
        expect(yield* call("capability_enable", { id: "mobile", profiles: ["android"] })).toMatchObject({
          type: "json",
          value: { state: "active", profiles: ["android"] },
        })
        probeFailures.add("xcodebuild -version")

        expect(yield* call("capability_status", { id: "mobile" })).toMatchObject({
          type: "json",
          value: {
            capabilities: [
              expect.objectContaining({
                state: "active",
                remediation: [],
                profileStatus: {
                  android: expect.objectContaining({ state: "healthy" }),
                  ios: expect.objectContaining({
                    state: "degraded",
                    remediation: expect.arrayContaining([expect.stringContaining("xcodebuild")]),
                  }),
                },
              }),
            ],
          },
        })
      }),
    ),
  )

  it.effect("reports missing required dependencies as failed and invalid persisted profiles as unavailable", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      probeExitCode = 1

      expect(yield* call("capability_status", { id: "browser" })).toMatchObject({
        type: "json",
        value: {
          capabilities: [expect.objectContaining({ id: "browser", state: "failed" })],
        },
      })

      activations.set(sessionID, [{ id: "browser", profiles: ["missing-profile"], state: "active" }])
      expect(yield* call("capability_status", { id: "browser" })).toMatchObject({
        type: "json",
        value: {
          capabilities: [expect.objectContaining({ id: "browser", state: "unavailable" })],
        },
      })

      activations.set(sessionID, [{ id: "browser", profiles: ["default"], state: "active" }])
      expect(yield* call("capability_status", { id: "browser" })).toMatchObject({
        type: "json",
        value: {
          capabilities: [expect.objectContaining({ id: "browser", state: "failed" })],
        },
      })
    }),
  )

  it.effect("filters next-turn capability lists with the invoking agent's permission rules", () =>
    Effect.gen(function* () {
      reset()
      agentPermissions = [
        { action: "browser_playwright_navigate", resource: "*", effect: "deny" },
        { action: "skill", resource: "browser-testing", effect: "deny" },
      ]
      yieldRegistry = yield* ToolRegistry.Service

      expect(yield* call("capability_enable", { id: "browser", profiles: ["default"] })).toMatchObject({
        type: "json",
        value: {
          tools: [],
          skills: [],
          availableTools: [],
          availableSkills: [],
          permissionFiltered: true,
        },
      })
    }),
  )

  it.effect("checks target-specific runtime input resources before execution", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      yield* call("capability_enable", { id: "browser", profiles: ["default"] })
      deniedResource = "https://example.com/private"

      expect(
        yield* (yield* yieldRegistry.materialize(sessionID)).settle({
          sessionID,
          ...identity,
          call: {
            type: "tool-call",
            id: "call-target-denied",
            name: "browser_playwright_navigate",
            input: { nested: { url: deniedResource }, path: "/tmp/file", duplicate: deniedResource },
          },
        }),
      ).toMatchObject({ result: { type: "error", value: "Permission denied: browser_playwright_navigate" } })
      expect(permissionRequests.at(-1)).toMatchObject({
        resources: ["mcp:playwright:browser_playwright_navigate", deniedResource, "/tmp/file"],
        save: ["mcp:playwright:browser_playwright_navigate"],
      })
      expect(runtimeCalls).toBe(0)
    }),
  )

  it.effect("fails closed when a denied target appears after the permission resource limit", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      yield* call("capability_enable", { id: "browser", profiles: ["default"] })
      permissionRequests = []
      const input: Record<string, string> = {}
      for (let index = 0; index < 31; index++) input[`filler${index}`] = `resource-${index}`
      deniedResource = "https://example.com/denied-after-limit"
      input.target = deniedResource

      expect(
        yield* (yield* yieldRegistry.materialize(sessionID)).settle({
          sessionID,
          ...identity,
          call: {
            type: "tool-call",
            id: "call-resource-overflow",
            name: "browser_playwright_navigate",
            input,
          },
        }),
      ).toMatchObject({
        result: { type: "error", value: "Capability permission resources exceed the safe limit" },
      })
      expect(permissionRequests).toHaveLength(0)
      expect(runtimeCalls).toBe(0)
    }),
  )

  it.effect("bounds cyclic and excessively deep untrusted permission input", () =>
    Effect.gen(function* () {
      reset()
      yieldRegistry = yield* ToolRegistry.Service
      yield* call("capability_enable", { id: "browser", profiles: ["default"] })
      permissionRequests = []
      const input: { next?: unknown } = {}
      let cursor = input
      for (let index = 0; index < 257; index++) {
        const next: { next?: unknown } = {}
        cursor.next = next
        cursor = next
      }
      cursor.next = input

      expect(
        yield* (yield* yieldRegistry.materialize(sessionID)).settle({
          sessionID,
          ...identity,
          call: {
            type: "tool-call",
            id: "call-node-overflow",
            name: "browser_playwright_navigate",
            input,
          },
        }),
      ).toMatchObject({
        result: { type: "error", value: "Capability permission resources exceed the safe limit" },
      })
      expect(permissionRequests).toHaveLength(0)
      expect(runtimeCalls).toBe(0)
    }),
  )
})

function withPlatform<A, E, R>(platform: "darwin" | "linux", effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => process.platform),
    () =>
      Effect.sync(() => Object.defineProperty(process, "platform", { configurable: true, value: platform })).pipe(
        Effect.andThen(effect),
      ),
    (original) =>
      Effect.sync(() => Object.defineProperty(process, "platform", { configurable: true, value: original })),
  )
}
