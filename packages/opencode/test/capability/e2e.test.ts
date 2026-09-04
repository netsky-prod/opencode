import path from "node:path"
import { afterEach, describe, expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CapabilityCatalog } from "@opencode-ai/core/capability/catalog"
import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { CapabilityRuntime as CoreCapabilityRuntime } from "@opencode-ai/core/capability/runtime"
import { CapabilityState } from "@opencode-ai/core/capability/state"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { CapabilityTool } from "@opencode-ai/core/tool/capability"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { WebFetchTool } from "@opencode-ai/core/tool/webfetch"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import type { ChildProcess } from "effect/unstable/process"
import { CapabilityRuntime } from "../../src/capability/runtime"
import { MCP } from "../../src/mcp"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const browserSession = SessionV2.ID.make("ses_capability_e2e_browser")
const otherSession = SessionV2.ID.make("ses_capability_e2e_other")
const identity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_capability_e2e"),
}
const activations = new Map<SessionV2.ID, CapabilityState.Activation[]>()
let packs: ReadonlyArray<CapabilityCatalog.Pack> = []

const catalog = CapabilityCatalog.Service.of({
  list: () => Effect.succeed(packs),
  get: (id) => Effect.succeed(packs.find((pack) => pack.id === id)),
  search: () => Effect.succeed(packs),
  register: () => Effect.void,
})
const state = CapabilityState.Service.of({
  list: (sessionID) => Effect.succeed(activations.get(sessionID) ?? []),
  status: (sessionID) => Effect.succeed(activations.get(sessionID) ?? []),
  enable: (input) =>
    Effect.sync(() => {
      activations.set(input.sessionID, [
        ...(activations.get(input.sessionID) ?? []).filter((activation) => activation.id !== input.id),
        { id: input.id, profiles: [...input.profiles], state: input.state ?? "active" },
      ])
    }),
  disable: (input) =>
    Effect.sync(() => {
      activations.set(
        input.sessionID,
        (activations.get(input.sessionID) ?? []).filter((activation) => activation.id !== input.id),
      )
    }),
})
const processLayer = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: (command: ChildProcess.Command) =>
      Effect.succeed({
        command: command._tag === "StandardCommand" ? command.command : "probe",
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
  } as unknown as AppProcess.Interface),
)
const permissionLayer = Layer.mock(PermissionV2.Service, { assert: () => Effect.void })
const agentLayer = Layer.mock(AgentV2.Service, {
  resolve: () => Effect.succeed(AgentV2.Info.make(AgentV2.Info.empty(identity.agent))),
})
const sessionLayer = Layer.mock(SessionStore.Service, {
  get: (id) => Effect.succeed({ id } as SessionV2.Info),
})
const layer = AppNodeBuilder.build(
  LayerNode.group([
    ApplicationTools.node,
    ToolRegistry.node,
    ToolRegistry.toolsNode,
    CapabilityTool.node,
    WebFetchTool.node,
    MCP.node,
    CapabilityRuntime.node,
  ]),
  [
    [CapabilityCatalog.node, Layer.succeed(CapabilityCatalog.Service, catalog)],
    [CapabilityState.node, Layer.succeed(CapabilityState.Service, state)],
    [CoreCapabilityRuntime.node, CapabilityRuntime.node],
    [AppProcess.node, processLayer],
    [PermissionV2.node, permissionLayer],
    [AgentV2.node, agentLayer],
    [SessionStore.node, sessionLayer],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ],
)
const it = testEffect(layer)

afterEach(() => {
  activations.clear()
  packs = []
})

describe("built-in capability end-to-end behavior", () => {
  it.effect(
    "isolates browser tools and preserves browser and research evidence",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const page = yield* servePage(test.directory)
      let currentPage: { readonly url: string; readonly body: string } | undefined
      const browser = yield* serveMcp(
        [
          tool("navigate", { url: stringProperty }),
          tool("inspect", {}),
          tool("take_screenshot", { path: stringProperty }),
        ],
        (name, input) =>
          Effect.gen(function* () {
            if (name === "navigate") {
              const url = String(input.url)
              currentPage = { url, body: yield* Effect.promise(() => fetch(url).then((response) => response.text())) }
              return { url, status: 200 }
            }
            if (name === "inspect") return { url: currentPage?.url, text: currentPage?.body }
            const location = String(input.path)
            yield* Effect.promise(() => Bun.write(location, screenshotPng))
            return { path: location, url: currentPage?.url }
          }),
      )
      const research = yield* serveMcp([tool("search", { query: stringProperty })], (_name, input) =>
        Effect.succeed({
          query: String(input.query),
          results: [
            {
              id: "primary-1",
              title: "Fixture Protocol Specification",
              url: new URL("/specification", page.url).toString(),
              publisher: "Fixture Standards Body",
              revised: "2026-09-01",
            },
          ],
        }),
      )
      packs = [pack("browser", "playwright", browser.url), pack("research", "federated", research.url)]
      const registry = yield* ToolRegistry.Service
      const before = yield* registry.materialize(browserSession)
      expect(names(before)).not.toContain("browser_playwright_navigate")

      yield* settle(before, browserSession, "capability_enable", { id: "browser", profiles: ["default"] })
      const browserTools = yield* registry.materialize(browserSession)
      const isolated = yield* registry.materialize(otherSession)
      expect(names(browserTools)).toContain("browser_playwright_navigate")
      expect(names(isolated)).not.toContain("browser_playwright_navigate")

      const fixtureUrl = new URL("/app", page.url).toString()
      const screenshot = path.join(page.directory, "artifacts", "verified.png")
      yield* settle(browserTools, browserSession, "browser_playwright_navigate", { url: fixtureUrl })
      const inspected = yield* settle(browserTools, browserSession, "browser_playwright_inspect", {})
      const captured = yield* settle(browserTools, browserSession, "browser_playwright_take_screenshot", {
        path: screenshot,
      })
      expect(inspected.output?.structured).toEqual({ url: fixtureUrl, text: "<h1>Verified fixture</h1>" })
      expect(captured.output?.structured).toEqual({ path: screenshot, url: fixtureUrl })
      expect((yield* Effect.promise(() => Bun.file(screenshot).arrayBuffer())).byteLength).toBe(
        screenshotPng.byteLength,
      )

      const management = yield* registry.materialize(browserSession)
      yield* settle(management, browserSession, "capability_enable", { id: "research", profiles: ["default"] })
      const researchTools = yield* registry.materialize(browserSession)
      const found = yield* settle(researchTools, browserSession, "research_federated_search", {
        query: "fixture protocol revision",
      })
      const citation = (found.output?.structured as { readonly results: ReadonlyArray<{ readonly url: string }> })
        .results[0]
      const fetched = yield* settle(researchTools, browserSession, "webfetch", {
        url: citation.url,
        format: "text",
      })
      expect(found.output?.structured).toMatchObject({
        results: [
          {
            id: "primary-1",
            title: "Fixture Protocol Specification",
            publisher: "Fixture Standards Body",
            revised: "2026-09-01",
          },
        ],
      })
      expect(fetched.result).toEqual({ type: "text", value: "Normative fixture requirement: preserve citations." })

      const enabled = yield* registry.materialize(browserSession)
      yield* settle(enabled, browserSession, "capability_disable", { id: "browser" })
      yield* settle(enabled, browserSession, "capability_disable", { id: "research" })
      const disabled = yield* registry.materialize(browserSession)
      expect(names(disabled)).not.toContain("browser_playwright_navigate")
      expect(names(disabled)).not.toContain("research_federated_search")
      yield* TestClock.adjust("31 seconds")
      expect(names(yield* registry.materialize(browserSession))).not.toContain("browser_playwright_navigate")
      expect(names(yield* registry.materialize(browserSession))).not.toContain("research_federated_search")
    }).pipe(withTmpdirInstance()),
  )
})

const stringProperty = { type: "string" as const }
const screenshotPng = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
)

function tool(name: string, properties: Readonly<Record<string, object>>): Tool {
  return {
    name,
    description: `Fixture ${name}`,
    inputSchema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
  }
}

function pack(id: "browser" | "research", runtime: "playwright" | "federated", url: string): CapabilityCatalog.Pack {
  return {
    id: CapabilityManifest.ID.make(id),
    version: 1,
    description: `${id} fixture capability`,
    platforms: ["darwin", "linux"],
    skills: [],
    runtimes: [
      CapabilityManifest.Runtime.make({
        id: CapabilityManifest.ID.make(runtime),
        type: "mcp",
        command: [url],
        tools: [],
        optional: false,
        timeoutMs: 2_000,
      }),
    ],
    profiles: {
      [CapabilityManifest.ID.make("default")]: {
        description: `${id} fixture profile`,
        skills: [],
        runtimes: [CapabilityManifest.ID.make(runtime)],
      },
    },
    source: "project",
    directory: AbsolutePath.make("/fixture"),
  }
}

function names(materialization: ToolRegistry.Materialization) {
  return materialization.definitions.map((definition) => definition.name)
}

function settle(materialization: ToolRegistry.Materialization, sessionID: SessionV2.ID, name: string, input: unknown) {
  return materialization.settle({
    sessionID,
    ...identity,
    call: { type: "tool-call", id: `call-${name}`, name, input },
  })
}

function servePage(directory: string) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const server = Bun.serve({
        port: 0,
        fetch: (request) =>
          new URL(request.url).pathname === "/app"
            ? new Response("<h1>Verified fixture</h1>", { headers: { "content-type": "text/html" } })
            : new Response("Normative fixture requirement: preserve citations.", {
                headers: { "content-type": "text/plain" },
              }),
      })
      return { server, url: server.url, directory }
    }),
    (fixture) => Effect.sync(() => fixture.server.stop(true)),
  )
}

function serveMcp(
  tools: ReadonlyArray<Tool>,
  call: (name: string, input: Readonly<Record<string, unknown>>) => Effect.Effect<Readonly<Record<string, unknown>>>,
) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server({ name: "capability-e2e", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [...tools] }))
      protocol.setRequestHandler(CallToolRequestSchema, (request) =>
        Effect.runPromise(call(request.params.name, request.params.arguments ?? {})).then((structuredContent) => ({
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
          structuredContent,
        })),
      )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const server = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) })
      return {
        url: server.url.toString(),
        close: async () => {
          await protocol.close().catch(() => undefined)
          server.stop(true)
        },
      }
    }),
    (fixture) => Effect.promise(fixture.close),
  )
}
