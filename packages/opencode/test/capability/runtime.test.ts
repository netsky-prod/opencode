import path from "node:path"
import { expect, test } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { CapabilityRuntime as CoreCapabilityRuntime } from "@opencode-ai/core/capability/runtime"
import { Node } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { CapabilityTool } from "@opencode-ai/core/tool/capability"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit } from "effect"
import { CapabilityRuntime } from "../../src/capability/runtime"
import { locationServices } from "../../src/location-services"
import { MCP } from "../../src/mcp"
import { McpAuth } from "../../src/mcp/auth"
import { testEffect } from "../lib/effect"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceState } from "../../src/effect/instance-state"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"

const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")
const it = testEffect(
  LayerNode.compile(LayerNode.group([EventV2.node, MCP.node, McpAuth.node, CapabilityRuntime.node])),
)

it.instance("does not report an unavailable always-on MCP reference as active", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const runtime = yield* CoreCapabilityRuntime.Service
    yield* mcp.add("unavailable", { type: "local", command: ["unused"] }, { connect: false })
    const result = yield* runtime
      .acquire("browser/playwright", definition("", { command: [], mcp: "unavailable" }))
      .pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect((yield* mcp.connection("unavailable"))?.status).toBe("disabled")
  }),
)

it.instance("a remote configured reference invokes tools with existing OAuth credentials under the original name", () =>
  Effect.gen(function* () {
    const server = yield* serveMcp(
      [{ name: "ping", inputSchema: { type: "object" } }],
      "called",
      "Bearer reference-only-secret",
    )
    const auth = yield* McpAuth.Service
    const mcp = yield* MCP.Service
    const runtime = yield* CoreCapabilityRuntime.Service
    yield* auth.set("oauth-reference", { tokens: { accessToken: "reference-only-secret" } }, server.url)
    yield* Effect.addFinalizer(() => auth.remove("oauth-reference"))
    yield* mcp.add(
      "oauth-reference",
      { type: "remote", url: server.url, exposure: "pack-only", timeout: 2000 },
      { hidden: true, connect: false },
    )
    const handle = yield* runtime.acquire("browser/playwright", definition("", { command: [], mcp: "oauth-reference" }))
    expect(yield* CapabilityRuntime.tools(handle)[0].call({})).toMatchObject({
      content: [{ type: "text", text: "called:ping" }],
    })
    expect(CapabilityRuntime.tools(handle)[0].permission?.action).toBe("oauth-reference_ping")
    expect(Object.keys(yield* mcp.tools())).toEqual([])
    expect(JSON.stringify(yield* runtime.status("browser/playwright"))).not.toContain("reference-only-secret")
    yield* runtime.release(handle)
  }),
)

it.instance(
  "starts pack-only configured references lazily and keeps always-on references schema-free",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const runtime = yield* CoreCapabilityRuntime.Service
      expect(Object.keys(yield* mcp.tools())).toEqual(["visible_current_directory"])
      expect((yield* mcp.connection("private"))?.status).toBe("disabled")
      const handle = yield* runtime.acquire("browser/playwright", definition("", { command: [], mcp: "private" }))
      expect(CapabilityRuntime.tools(handle).map((tool) => tool.name)).toEqual(["private_current_directory"])
      const shared = yield* runtime.acquire("other/playwright", definition("", { command: [], mcp: "private" }))
      expect(CapabilityRuntime.tools(shared).map((tool) => tool.name)).toEqual(["private_current_directory"])
      yield* runtime.release(shared)
      expect(Object.keys(yield* mcp.tools())).toEqual(["visible_current_directory"])
      yield* runtime.release(handle)
      const visible = yield* runtime.acquire(
        "browser/playwright#visible",
        definition("", { command: [], mcp: "visible" }),
      )
      expect(CapabilityRuntime.tools(visible)).toEqual([])
      yield* runtime.release(visible)
      expect((yield* mcp.connection("visible"))?.status).toBe("connected")
    }),
  {
    config: {
      mcp: {
        private: { type: "local", command: [process.execPath, stdioFixture], exposure: "pack-only" },
        visible: { type: "local", command: [process.execPath, stdioFixture] },
      },
    },
  },
)

it.instance("binds host MCP context for a Core background location without a legacy request", () =>
  Effect.gen(function* () {
    const directory = yield* InstanceState.directory
    const server = yield* serveMcp([{ name: "ping", inputSchema: { type: "object", properties: {} } }])
    yield* Effect.gen(function* () {
      const runtime = yield* CoreCapabilityRuntime.Service
      const handle = yield* runtime.acquire("browser/playwright", definition(server.url))
      expect(yield* CapabilityRuntime.tools(handle)[0].call({})).toMatchObject({
        content: [{ type: "text", text: "called:ping" }],
      })
      yield* runtime.release(handle)
    }).pipe(
      Effect.provide(
        AppNodeBuilderV1.build(CapabilityRuntime.adapterNode, [
          [Location.node, Location.boundNode({ directory: AbsolutePath.make(directory) })],
        ]),
      ),
      Effect.provideService(InstanceRef, undefined),
    )
  }),
)

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

function serveMcp(tools: ReadonlyArray<Tool>, version = "called", authorization?: string) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server(
        { name: "capability-runtime-test", version: "1.0.0" },
        { capabilities: { tools: {} } },
      )
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [...tools] }))
      protocol.setRequestHandler(CallToolRequestSchema, (request) =>
        Promise.resolve({ content: [{ type: "text" as const, text: `${version}:${request.params.name}` }] }),
      )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const http = Bun.serve({
        port: 0,
        fetch: (request) =>
          authorization && request.headers.get("authorization") !== authorization
            ? new Response("Unauthorized", { status: 401 })
            : transport.handleRequest(request),
      })
      return {
        url: http.url.toString(),
        close: async () => {
          await protocol.close().catch(() => {})
          void http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function environment(values: Readonly<Record<string, string | undefined>>) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }),
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
    expect(yield* tools[0].call({ url: "https://example.com" })).toMatchObject({
      content: [{ type: "text", text: "called:navigate" }],
    })
  }),
)

it.instance("publishes the Core runtime lifecycle without exposing the remote endpoint", () =>
  Effect.gen(function* () {
    const server = yield* serveMcp([{ name: "navigate", inputSchema: { type: "object" } }])
    const runtime = yield* CoreCapabilityRuntime.Service
    const events = yield* EventV2.Service
    const observed: EventV2.Payload[] = []
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        if (event.type.startsWith("capability.runtime.")) observed.push(event)
      }),
    )

    yield* runtime.acquire("browser/playwright#private-host-reference", definition(server.url))
    yield* unsubscribe

    expect(observed.map((event) => event.type)).toEqual(["capability.runtime.started"])
    expect(observed[0]?.data).toMatchObject({ runtimeID: "playwright", state: "healthy", referenceCount: 1 })
    expect(JSON.stringify(observed)).not.toContain(server.url)
    expect(JSON.stringify(observed)).not.toContain("private-host-reference")
  }),
)

it.instance(
  "resolves exact environment references before remote classification and maps remote environment to headers",
  () =>
    Effect.gen(function* () {
      const secret = "Bearer capability-adapter-secret"
      const server = yield* serveMcp([{ name: "search", inputSchema: { type: "object" } }], "resolved", secret)
      yield* environment({
        OPENCODE_TEST_CAPABILITY_MCP_URL: server.url,
        OPENCODE_TEST_CAPABILITY_AUTHORIZATION: secret,
      })
      const runtime = yield* CoreCapabilityRuntime.Service
      const reference = yield* runtime.acquire(
        "research/federated",
        CapabilityManifest.Runtime.make({
          id: CapabilityManifest.ID.make("federated"),
          type: "mcp",
          command: ["${OPENCODE_TEST_CAPABILITY_MCP_URL}"],
          environment: { Authorization: "${OPENCODE_TEST_CAPABILITY_AUTHORIZATION}" },
          tools: [],
          optional: false,
          timeoutMs: 2_000,
        }),
      )

      expect(CapabilityRuntime.tools(reference).map((tool) => tool.name)).toEqual(["research_federated_search"])
      expect(yield* CapabilityRuntime.tools(reference)[0].call({})).toMatchObject({
        content: [{ type: "text", text: "resolved:search" }],
      })
      expect(JSON.stringify(yield* runtime.status(reference.key))).not.toContain(secret)
    }),
)

it.instance("fails with an actionable variable name when an exact environment reference is missing", () =>
  Effect.gen(function* () {
    yield* environment({ OPENCODE_TEST_CAPABILITY_MISSING_URL: undefined })
    const runtime = yield* CoreCapabilityRuntime.Service
    const error = yield* runtime
      .acquire(
        "research/missing",
        CapabilityManifest.Runtime.make({
          id: CapabilityManifest.ID.make("missing"),
          type: "mcp",
          command: ["${OPENCODE_TEST_CAPABILITY_MISSING_URL}"],
          tools: [],
          optional: false,
          timeoutMs: 2_000,
        }),
      )
      .pipe(Effect.flip)

    expect(error.diagnostic).toBe("Missing environment variable OPENCODE_TEST_CAPABILITY_MISSING_URL")
  }),
)

it.instance("redacts resolved environment values from startup failures", () =>
  Effect.gen(function* () {
    const secret = "opencode-secret-mcp-executable"
    yield* environment({ OPENCODE_TEST_CAPABILITY_SECRET_COMMAND: secret })
    const runtime = yield* CoreCapabilityRuntime.Service
    const error = yield* runtime
      .acquire(
        "research/redaction",
        CapabilityManifest.Runtime.make({
          id: CapabilityManifest.ID.make("redaction"),
          type: "mcp",
          command: ["${OPENCODE_TEST_CAPABILITY_SECRET_COMMAND}", "--stdio"],
          tools: [],
          optional: false,
          timeoutMs: 2_000,
        }),
      )
      .pipe(Effect.flip)

    expect(error.diagnostic).toContain("[redacted]")
    expect(error.diagnostic).not.toContain(secret)
  }),
)

it.instance("starts a changed capability runtime while another session still holds the old version", () =>
  Effect.gen(function* () {
    const oldServer = yield* serveMcp([{ name: "navigate", inputSchema: { type: "object" } }], "old")
    const newServer = yield* serveMcp([{ name: "navigate", inputSchema: { type: "object" } }], "new")
    const runtime = yield* CoreCapabilityRuntime.Service
    const oldKey = "browser/playwright#old-fingerprint"
    const newKey = "browser/playwright#new-fingerprint"
    const activationA = yield* runtime.activate([{ key: oldKey, definition: definition(oldServer.url) }])
    const activationB = yield* runtime.activate([{ key: newKey, definition: definition(newServer.url) }])
    if (activationA.state === "failed" || activationB.state === "failed") throw new Error("Runtime activation failed")
    const sessionA = activationA.references[0]
    const sessionB = activationB.references[0]

    expect(CapabilityRuntime.tools(sessionA).map((tool) => tool.name)).toEqual(["browser_playwright_navigate"])
    expect(CapabilityRuntime.tools(sessionB).map((tool) => tool.name)).toEqual(["browser_playwright_navigate"])
    expect(yield* CapabilityRuntime.tools(sessionA)[0].call({ url: "https://old.example" })).toMatchObject({
      content: [{ type: "text", text: "old:navigate" }],
    })
    expect(yield* CapabilityRuntime.tools(sessionB)[0].call({ url: "https://new.example" })).toMatchObject({
      content: [{ type: "text", text: "new:navigate" }],
    })
    expect((yield* runtime.status(sessionA.key)).references).toBe(1)
    expect((yield* runtime.status(sessionB.key)).references).toBe(1)

    yield* runtime.release(sessionA)
    expect((yield* runtime.status(sessionA.key)).references).toBe(0)
    expect((yield* runtime.status(sessionB.key)).references).toBe(1)
    expect(yield* CapabilityRuntime.tools(sessionB)[0].call({ url: "https://still-new.example" })).toMatchObject({
      content: [{ type: "text", text: "new:navigate" }],
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
