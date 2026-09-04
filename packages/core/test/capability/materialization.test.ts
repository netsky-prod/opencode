import { describe, expect } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CapabilityState } from "@opencode-ai/core/capability/state"
import { CapabilityCatalog } from "@opencode-ai/core/capability/catalog"
import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Effect, Layer, Schema, Scope, Exit } from "effect"
import { testEffect } from "../lib/effect"

const first = SessionV2.ID.make("ses_capability_materialization_first")
const second = SessionV2.ID.make("ses_capability_materialization_second")
const identity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_capability_materialization"),
}

const activations = new Map<SessionV2.ID, CapabilityState.Activation[]>()
const retained: ToolOutputStore.BoundInput[] = []
const state = CapabilityState.Service.of({
  list: (sessionID) => Effect.succeed(activations.get(sessionID) ?? []),
  enable: (input) =>
    Effect.sync(() => {
      activations.set(input.sessionID, [{ id: input.id, profiles: input.profiles, state: input.state ?? "active" }])
    }),
  disable: (input) =>
    Effect.sync(() => {
      activations.set(
        input.sessionID,
        (activations.get(input.sessionID) ?? []).filter((activation) => activation.id !== input.id),
      )
    }),
  status: (sessionID) => Effect.succeed(activations.get(sessionID) ?? []),
})
const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.sync(() => retained.push(input)).pipe(Effect.as({ output: input.output, outputPaths: [] })),
})
const layer = AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, ToolRegistry.node]), [
  [CapabilityState.node, Layer.succeed(CapabilityState.Service, state)],
  [ToolOutputStore.node, outputStore],
])
const it = testEffect(layer)

const publicSkill = SkillV2.Info.make({
  name: "public",
  description: "Always available guidance",
  location: AbsolutePath.make("/skills/public.md"),
  content: "# Public",
})
const browserPack: CapabilityCatalog.Pack = {
  id: CapabilityManifest.ID.make("browser"),
  version: 1,
  description: "Inspect browser pages.",
  platforms: ["darwin", "linux"],
  source: "builtin",
  directory: AbsolutePath.make("/capabilities/browser"),
  skills: [
    {
      name: CapabilityManifest.ID.make("browser-testing"),
      description: "Inspect browser failures.",
      path: "browser-testing.md",
      location: AbsolutePath.make("/capabilities/browser/browser-testing.md"),
      content: "# Browser Testing",
    },
  ],
  runtimes: [],
  profiles: {
    [CapabilityManifest.ID.make("default")]: {
      description: "Inspect browser pages.",
      skills: [CapabilityManifest.ID.make("browser-testing")],
      runtimes: [],
    },
    [CapabilityManifest.ID.make("diagnostics")]: {
      description: "Inspect browser diagnostics.",
      skills: [],
      runtimes: [],
    },
  },
}
const catalog = CapabilityCatalog.Service.of({
  list: () => Effect.succeed([browserPack]),
  get: (id) => Effect.succeed(id === browserPack.id ? browserPack : undefined),
  search: () => Effect.succeed([]),
  register: () => Effect.void,
})
const skillLayer = AppNodeBuilder.build(
  LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SkillTool.node, SkillGuidance.node]),
  [
    [CapabilityCatalog.node, Layer.succeed(CapabilityCatalog.Service, catalog)],
    [CapabilityState.node, Layer.succeed(CapabilityState.Service, state)],
    [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
    [SkillV2.node, Layer.mock(SkillV2.Service, { list: () => Effect.succeed([publicSkill]) })],
    [ToolOutputStore.node, outputStore],
  ],
)
const skillIt = testEffect(skillLayer)

const echo = (value: string) =>
  Tool.make({
    description: "Echo a value",
    input: Schema.Struct({}),
    output: Schema.String,
    execute: () => Effect.succeed(value),
  })

const names = (materialization: ToolRegistry.Materialization) => materialization.definitions.map((tool) => tool.name)
const call = (name: string) => ({
  sessionID: first,
  ...identity,
  call: { type: "tool-call" as const, id: `call-${name}`, name, input: {} },
})

describe("capability materialization", () => {
  it.effect("rejects settlement through a different session before execution or output retention", () =>
    Effect.gen(function* () {
      activations.clear()
      retained.length = 0
      let executions = 0
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        guarded: Tool.make({
          description: "Record execution",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.sync(() => executions++).pipe(Effect.as("guarded")),
        }),
      })
      const materialized = yield* registry.materialize(first)

      expect(
        yield* materialized.settle({
          ...call("guarded"),
          sessionID: second,
        }),
      ).toEqual({
        result: { type: "error", value: "Tool materialization belongs to another session" },
      })
      expect(executions).toBe(0)
      expect(retained).toEqual([])
    }),
  )

  it.effect("resolves the newest visible local registration and falls back to the application registration", () =>
    Effect.gen(function* () {
      activations.clear()
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      yield* applications.register({ shared: echo("application") })
      yield* registry.register({
        shared: Tool.withOrigin(echo("default"), {
          type: "mcp",
          serverID: "playwright",
          capability: "browser",
          profile: "default",
        }),
      })
      yield* registry.register({
        shared: Tool.withOrigin(echo("diagnostics"), {
          type: "mcp",
          serverID: "playwright",
          capability: "browser",
          profile: "diagnostics",
        }),
      })
      yield* state.enable({ sessionID: first, id: "browser", profiles: ["default"] })

      const enabled = yield* registry.materialize(first)
      expect(names(enabled)).toContain("shared")
      expect(yield* enabled.settle(call("shared"))).toMatchObject({ result: { type: "text", value: "default" } })

      const configured = yield* registry.materialize(second)
      expect(names(configured)).toContain("shared")
      expect(
        yield* configured.settle({
          ...call("shared"),
          sessionID: second,
        }),
      ).toMatchObject({ result: { type: "text", value: "application" } })
    }),
  )

  it.effect("an inactive overlay does not stale an advertised configured tool", () =>
    Effect.gen(function* () {
      activations.clear()
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      yield* applications.register({ configured: echo("application") })
      yield* state.enable({ sessionID: first, id: "browser", profiles: ["default"] })
      const advertised = yield* registry.materialize(second)
      yield* registry.register({
        configured: Tool.withOrigin(echo("inactive"), {
          type: "mcp",
          serverID: "playwright",
          capability: "browser",
          profile: "default",
        }),
      })

      expect(yield* (yield* registry.materialize(first)).settle(call("configured"))).toMatchObject({
        result: { type: "text", value: "inactive" },
      })

      expect(
        yield* advertised.settle({
          ...call("configured"),
          sessionID: second,
        }),
      ).toMatchObject({ result: { type: "text", value: "application" } })
    }),
  )

  it.effect("only the enabling session receives pack tools for the selected profile", () =>
    Effect.gen(function* () {
      activations.clear()
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        baseline: echo("baseline"),
        configured_mcp: Tool.withOrigin(echo("configured"), { type: "mcp", serverID: "configured" }),
        browser_playwright_navigate: Tool.withOrigin(echo("browser"), {
          type: "mcp",
          serverID: "playwright",
          capability: "browser",
          profile: "default",
        }),
        browser_playwright_diagnostics: Tool.withOrigin(echo("diagnostics"), {
          type: "mcp",
          serverID: "playwright",
          capability: "browser",
          profile: "diagnostics",
        }),
      })

      yield* state.enable({ sessionID: first, id: "browser", profiles: ["default"] })

      expect(names(yield* registry.materialize(first))).toEqual([
        "baseline",
        "configured_mcp",
        "browser_playwright_navigate",
      ])
      expect(names(yield* registry.materialize(second))).toEqual(["baseline", "configured_mcp"])
    }),
  )

  it.effect("a captured materialization settles after disable but rejects a replacement identity", () =>
    Effect.gen(function* () {
      activations.clear()
      const registry = yield* ToolRegistry.Service
      const original = yield* Scope.make()
      yield* registry
        .register({
          browser_playwright_navigate: Tool.withOrigin(echo("original"), {
            type: "mcp",
            serverID: "playwright",
            capability: "browser",
            profile: "default",
          }),
        })
        .pipe(Scope.provide(original))
      yield* state.enable({ sessionID: first, id: "browser", profiles: ["default"] })
      const advertised = yield* registry.materialize(first)

      yield* state.disable({ sessionID: first, id: "browser" })
      expect(yield* advertised.settle(call("browser_playwright_navigate"))).toMatchObject({
        result: { type: "text", value: "original" },
      })
      expect(names(yield* registry.materialize(first))).not.toContain("browser_playwright_navigate")

      yield* Scope.close(original, Exit.void)
      yield* registry.register({
        browser_playwright_navigate: Tool.withOrigin(echo("replacement"), {
          type: "mcp",
          serverID: "playwright",
          capability: "browser",
          profile: "default",
        }),
      })
      expect(yield* advertised.settle(call("browser_playwright_navigate"))).toMatchObject({
        result: { type: "error", value: "Stale tool call: browser_playwright_navigate" },
      })
    }),
  )

  skillIt.live("pack skills have identical session visibility in guidance and loading", () =>
    Effect.gen(function* () {
      activations.clear()
      const guidance = yield* SkillGuidance.Service
      const registry = yield* ToolRegistry.Service
      const agent = AgentV2.Info.make(AgentV2.Info.empty(identity.agent))
      const visible = (sessionID: SessionV2.ID) =>
        guidance.load(sessionID, { id: agent.id, info: agent }).pipe(
          Effect.flatMap(SystemContext.initialize),
          Effect.map((context) => context.baseline),
        )
      const load = (sessionID: SessionV2.ID, name: string) =>
        registry.materialize(sessionID).pipe(
          Effect.flatMap((materialized) =>
            materialized.settle({
              sessionID,
              ...identity,
              call: { type: "tool-call", id: `call-${sessionID}-${name}`, name: "skill", input: { name } },
            }),
          ),
          Effect.map((settlement) => settlement.result),
        )

      expect(yield* visible(second)).toContain("<name>public</name>")
      expect(yield* visible(second)).not.toContain("<name>browser-testing</name>")
      expect(yield* load(second, "browser-testing")).toEqual({
        type: "error",
        value: "Unable to load skill browser-testing",
      })

      yield* state.enable({ sessionID: second, id: "browser", profiles: ["default"] })
      expect(yield* visible(second)).toContain("<name>browser-testing</name>")
      expect(yield* visible(first)).not.toContain("<name>browser-testing</name>")
      expect(yield* load(second, "browser-testing")).toMatchObject({
        type: "text",
        value: expect.stringContaining("# Browser Testing"),
      })

      yield* state.disable({ sessionID: second, id: "browser" })
      expect(yield* visible(second)).not.toContain("<name>browser-testing</name>")
      expect(yield* load(second, "browser-testing")).toEqual({
        type: "error",
        value: "Unable to load skill browser-testing",
      })

      yield* state.enable({ sessionID: second, id: "browser", profiles: ["diagnostics"] })
      expect(yield* visible(second)).not.toContain("<name>browser-testing</name>")
      expect(yield* load(second, "browser-testing")).toEqual({
        type: "error",
        value: "Unable to load skill browser-testing",
      })
      expect(yield* load(second, "public")).toMatchObject({
        type: "text",
        value: expect.stringContaining("# Public"),
      })
    }),
  )
})
