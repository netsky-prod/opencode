import path from "node:path"
import { expect, test } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { CapabilityRuntime as CoreCapabilityRuntime } from "@opencode-ai/core/capability/runtime"
import { Node } from "@opencode-ai/core/effect/app-node"
import { CapabilityTool } from "@opencode-ai/core/tool/capability"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit } from "effect"
import { CapabilityRuntime } from "../../src/capability/runtime"
import { locationServices } from "../../src/location-services"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"

const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")
const it = testEffect(LayerNode.compile(LayerNode.group([MCP.node, CapabilityRuntime.node])))

test("the OpenCode adapter satisfies Core capability-tool composition", () => {
  const composed = LayerNode.hoist(CapabilityTool.node, Node.tags.values.global, [
    [CoreCapabilityRuntime.node, CapabilityRuntime.node],
  ])
  expect(LayerNode.hasUnbound(composed.node, CoreCapabilityRuntime.node)).toBe(false)
})

test("the shared OpenCode location composition binds the Core capability runtime", () => {
  expect(LayerNode.hasUnbound(locationServices.node, CoreCapabilityRuntime.node)).toBe(false)
})

const definition = (url: string, input: Partial<CapabilityManifest.Runtime> = {}) =>
  CapabilityManifest.Runtime.make({
    id: CapabilityManifest.ID.make("playwright"),
    type: "mcp",
    command: [url],
    tools: [],
    optional: false,
    timeoutMs: 2_000,
    ...input,
  })

function serveMcp(tools: ReadonlyArray<Tool>) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server(
        { name: "capability-runtime-test", version: "1.0.0" },
        { capabilities: { tools: {} } },
      )
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [...tools] }))
      protocol.setRequestHandler(CallToolRequestSchema, (request) =>
        Promise.resolve({ content: [{ type: "text" as const, text: `called:${request.params.name}` }] }),
      )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const http = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) })
      return {
        url: http.url.toString(),
        close: async () => {
          await protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

it.instance("starts a manifest-owned MCP and exposes immutable canonical definitions without global config", () =>
  Effect.gen(function* () {
    const server = yield* serveMcp([
      {
        name: "navigate",
        description: "Navigate the browser",
        inputSchema: { type: "object", properties: { url: { type: "string" } } },
      },
    ])
    const runtime = yield* CoreCapabilityRuntime.Service
    const mcp = yield* MCP.Service
    const handle = yield* runtime.acquire("browser/playwright", definition(server.url))
    const tools = CapabilityRuntime.tools(handle)

    expect(tools.map((tool) => tool.name)).toEqual(["browser_playwright_navigate"])
    expect(Object.keys(yield* mcp.tools())).toEqual([])
    expect(Object.keys(yield* mcp.clients())).toEqual([])
    expect(Object.keys(yield* mcp.status())).toEqual([])
    expect(Object.isFrozen(tools)).toBe(true)
    expect(Object.isFrozen(tools[0])).toBe(true)
    expect(yield* tools[0]!.call({ url: "https://example.com" })).toMatchObject({
      content: [{ type: "text", text: "called:navigate" }],
    })
  }),
)

it.instance(
  "keeps configured MCPs connected and omits resolved environment values from runtime status",
  () =>
    Effect.gen(function* () {
      const secret = "manifest-runtime-secret"
      const runtime = yield* CoreCapabilityRuntime.Service
      const mcp = yield* MCP.Service
      yield* runtime.acquire(
        "browser/playwright",
        CapabilityManifest.Runtime.make({
          id: CapabilityManifest.ID.make("playwright"),
          type: "mcp",
          command: [process.execPath, stdioFixture],
          environment: { TOKEN: secret },
          tools: [],
          optional: false,
          timeoutMs: 2_000,
        }),
      )

      expect((yield* mcp.status()).configured?.status).toBe("connected")
      expect(JSON.stringify(yield* runtime.status("browser/playwright"))).not.toContain(secret)
    }),
  {
    config: {
      mcp: {
        configured: { type: "local", command: [process.execPath, stdioFixture] },
      },
    },
  },
)

it.instance("does not remove a pre-existing dynamic MCP after a capability registration collision", () =>
  Effect.gen(function* () {
    const existing = yield* serveMcp([{ name: "existing", inputSchema: { type: "object" } }])
    const candidate = yield* serveMcp([{ name: "candidate", inputSchema: { type: "object" } }])
    const runtime = yield* CoreCapabilityRuntime.Service
    const mcp = yield* MCP.Service
    yield* mcp.add("__capability_browser_playwright", {
      type: "remote",
      url: existing.url,
      oauth: false,
      timeout: 2_000,
    })

    const result = yield* runtime.acquire("browser/playwright", definition(candidate.url)).pipe(Effect.exit)

    expect(Exit.isFailure(result)).toBe(true)
    expect((yield* mcp.status()).__capability_browser_playwright?.status).toBe("connected")
    expect(Object.keys(yield* mcp.tools())).toEqual(["__capability_browser_playwright_existing"])
  }),
)

it.instance("rejects runtime-discovered canonical tool collisions and unregisters the failed server", () =>
  Effect.gen(function* () {
    const server = yield* serveMcp([
      { name: "navigate.page", inputSchema: { type: "object" } },
      { name: "navigate_page", inputSchema: { type: "object" } },
    ])
    const runtime = yield* CoreCapabilityRuntime.Service
    const mcp = yield* MCP.Service
    const result = yield* runtime.acquire("browser/playwright", definition(server.url)).pipe(Effect.exit)

    expect(Exit.isFailure(result)).toBe(true)
    expect((yield* runtime.status("browser/playwright")).state).toBe("failed")
    expect(Object.keys(yield* mcp.status()).some((name) => name.startsWith("__capability_"))).toBe(false)
  }),
)
