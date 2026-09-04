import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { ChildProcess } from "effect/unstable/process"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CapabilityCatalog } from "@opencode-ai/core/capability/catalog"
import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { CapabilityRuntime } from "@opencode-ai/core/capability/runtime"
import { CapabilityState } from "@opencode-ai/core/capability/state"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
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

const packs = Array.from({ length: 12 }, (_, index) => pack(index))
const activations = new Map<SessionV2.ID, CapabilityState.Activation[]>()
const events: string[] = []
let runtimeFailure = false
let runtimeState: CapabilityRuntime.Status["state"] = "healthy"
let diagnostic = ""
let runtimeCalls = 0
let denyRuntime = false
let probeExitCode = 0

const catalog = CapabilityCatalog.Service.of({
  list: () => Effect.succeed(packs),
  get: (id) => Effect.succeed(packs.find((item) => item.id === id)),
  search: (_query, active) =>
    Effect.succeed([...packs.filter((item) => !active.has(item.id)), ...packs.filter((item) => active.has(item.id))]),
  register: () => Effect.void,
})

const state = CapabilityState.Service.of({
  list: (id) => Effect.succeed(activations.get(id) ?? []),
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

const reference = {
  key: "browser/playwright",
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
            return { navigated: input }
          }),
      },
    ],
  },
} as unknown as CapabilityRuntime.Reference

const runtime = CapabilityRuntime.Service.of({
  acquire: () => Effect.succeed(reference),
  release: () => Effect.sync(() => events.push("runtime:release")),
  activate: () =>
    Effect.sync(() => {
      events.push("runtime:activate")
      return runtimeFailure
        ? ({ state: "failed", references: [], diagnostic: "startup failed" } as const)
        : ({ state: "active", references: [reference] } as const)
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
        return {
          command: command._tag === "StandardCommand" ? command.command : "probe",
          exitCode: probeExitCode,
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
    Effect.sync(() => events.push(`permission:${input.action}`)).pipe(
      Effect.andThen(denyRuntime ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
    ),
})

const layer = AppNodeBuilder.build(
  LayerNode.group([ApplicationTools.node, ToolRegistry.node, ToolRegistry.toolsNode, CapabilityTool.node]),
  [
    [CapabilityCatalog.node, Layer.succeed(CapabilityCatalog.Service, catalog)],
    [CapabilityState.node, Layer.succeed(CapabilityState.Service, state)],
    [CapabilityRuntime.node, Layer.succeed(CapabilityRuntime.Service, runtime)],
    [AppProcess.node, appProcess],
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ],
)
const it = testEffect(layer)

const reset = () => {
  activations.clear()
  events.length = 0
  runtimeFailure = false
  runtimeState = "healthy"
  diagnostic = ""
  runtimeCalls = 0
  denyRuntime = false
  probeExitCode = 0
}

const names = (materialized: ToolRegistry.Materialization) =>
  materialized.definitions.map((definition) => definition.name).toSorted()

const call = (name: string, input: unknown) =>
  executeTool(yieldRegistry, {
    sessionID,
    ...identity,
    call: { type: "tool-call", id: `call-${name}`, name, input },
  })

let yieldRegistry: ToolRegistry.Interface

describe("CapabilityTool", () => {
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
        },
      })
      expect(events.slice(0, 3)).toEqual(["probe", "runtime:activate", "persist:enable"])

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
      expect(events).toEqual(["probe"])
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
      expect(events).toEqual(["persist:disable", "runtime:release"])
      expect(names(yield* yieldRegistry.materialize(sessionID))).not.toContain("browser_playwright_navigate")
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
})
