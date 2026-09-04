import fs from "node:fs/promises"
import { watch } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CapabilityCatalog } from "@opencode-ai/core/capability/catalog"
import { CapabilityRuntime as CoreCapabilityRuntime } from "@opencode-ai/core/capability/runtime"
import { CapabilityState } from "@opencode-ai/core/capability/state"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { AppProcess } from "@opencode-ai/core/process"
import { Project } from "@opencode-ai/core/project"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { CapabilityTool } from "@opencode-ai/core/tool/capability"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { WebFetchTool } from "@opencode-ai/core/tool/webfetch"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { DateTime, Effect, Layer } from "effect"
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
const root = AbsolutePath.make(path.resolve(import.meta.dir, "../../../.."))
const locationRef = Location.Ref.make({ directory: root })
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory: root,
    workspaceID: locationRef.workspaceID,
    project: { id: Project.ID.global, directory: root },
  }),
)
let context7FixtureUrl: string | undefined

const catalogLayer = Layer.effect(
  CapabilityCatalog.Service,
  CapabilityCatalog.make({
    globalDirectory: path.join(import.meta.dir, "../fixture/capabilities/global"),
    projectDirectory: path.join(import.meta.dir, "../fixture/capabilities/project"),
  }).pipe(
    Effect.map((catalog) =>
      CapabilityCatalog.Service.of({
        register: catalog.register,
        list: () => catalog.list().pipe(Effect.map((packs) => packs.map(adaptFixtureTransport))),
        get: (id) => catalog.get(id).pipe(Effect.map((pack) => (pack ? adaptFixtureTransport(pack) : undefined))),
        search: (query, active) =>
          catalog.search(query, active).pipe(Effect.map((packs) => packs.map(adaptFixtureTransport))),
      }),
    ),
  ),
)
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
const processLayer = Layer.mock(AppProcess.Service, {
  run: (command: ChildProcess.Command) =>
    Effect.succeed({
      command: command._tag === "StandardCommand" ? command.command : "probe",
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
})
const permissionLayer = Layer.mock(PermissionV2.Service, { assert: () => Effect.void })
const agentLayer = Layer.mock(AgentV2.Service, {
  resolve: () => Effect.succeed(AgentV2.Info.make(AgentV2.Info.empty(identity.agent))),
})
const sessionLayer = Layer.mock(SessionStore.Service, {
  get: (id) =>
    Effect.succeed(
      SessionV2.Info.make({
        id,
        projectID: Project.ID.global,
        title: "capability e2e",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: root },
      }),
    ),
})
const layer = AppNodeBuilder.build(
  LayerNode.group([
    CapabilityCatalog.node,
    ApplicationTools.node,
    ToolRegistry.node,
    ToolRegistry.toolsNode,
    CapabilityTool.node,
    SkillTool.node,
    SkillGuidance.node,
    WebFetchTool.node,
    MCP.node,
    CapabilityRuntime.node,
    PluginV2.node,
    PluginInternal.node,
  ]),
  [
    [CapabilityCatalog.node, catalogLayer],
    [CapabilityState.node, Layer.succeed(CapabilityState.Service, state)],
    [CoreCapabilityRuntime.node, CapabilityRuntime.node],
    [Location.node, locationLayer],
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
  context7FixtureUrl = undefined
})

describe("built-in capability end-to-end behavior", () => {
  it.effect(
    "loads shipped packs, isolates sessions, preserves evidence, and closes the idle browser process",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const page = yield* servePage(test.directory)
      const closeMarker = path.join(test.directory, "browser-closed")
      const bin = yield* installNpxFixture(test.directory)
      const secret = "Bearer capability-e2e-secret"
      const federated = yield* serveMcp(
        [tool("search", { query: stringProperty })],
        (_name, input) =>
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
        secret,
      )
      const context7 = yield* serveMcp([tool("resolve-library-id", { libraryName: stringProperty })], (_name, input) =>
        Effect.succeed({ library: String(input.libraryName), id: "/fixture/library" }),
      )
      context7FixtureUrl = context7.url
      yield* environment({
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        FEDERATED_RESEARCH_MCP_URL: federated.url,
        FEDERATED_RESEARCH_AUTHORIZATION: secret,
        OPENCODE_TEST_BROWSER_CLOSE_MARKER: closeMarker,
      })

      const plugin = yield* PluginV2.Service
      yield* plugin.wait(PluginV2.ID.make("capability"))
      const catalog = yield* CapabilityCatalog.Service
      const browserPack = yield* catalog.get("browser")
      const researchPack = yield* catalog.get("research")
      expect(browserPack).toMatchObject({
        source: "builtin",
        profiles: { default: {}, diagnostics: {} },
        runtimes: [
          { id: "playwright" },
          { id: "chrome-devtools", command: ["npx", "-y", "chrome-devtools-mcp@1.8.0"] },
        ],
      })
      expect(browserPack?.skills[0]?.content).toContain("Save a screenshot for the final verified state")
      expect(researchPack).toMatchObject({ source: "builtin", profiles: { default: {} } })
      expect(researchPack?.runtimes.find((runtime) => runtime.id === "federated-research")?.command).toEqual([
        "${FEDERATED_RESEARCH_MCP_URL}",
      ])
      expect(researchPack?.skills[0]?.content).toContain("Fetch every decisive primary-source URL")

      const registry = yield* ToolRegistry.Service
      const before = yield* registry.materialize(browserSession)
      expect(
        names(before)
          .filter((name) => name.startsWith("capability_"))
          .toSorted(),
      ).toEqual(["capability_disable", "capability_enable", "capability_search", "capability_status"])
      expect(names(before)).not.toContain("browser_playwright_browser_navigate")
      yield* settle(before, browserSession, "capability_enable", { id: "browser", profiles: ["default"] })
      const browserTools = yield* registry.materialize(browserSession)
      const isolated = yield* registry.materialize(otherSession)
      expect(names(browserTools)).toContain("browser_playwright_browser_navigate")
      expect(names(browserTools)).not.toContain("browser_chrome-devtools_list_console_messages")
      expect(names(isolated)).not.toContain("browser_playwright_browser_navigate")

      const fixtureUrl = new URL("/app", page.url).toString()
      const screenshot = path.join(page.directory, "artifacts", "verified.png")
      yield* settle(browserTools, browserSession, "browser_playwright_browser_navigate", { url: fixtureUrl })
      const inspected = yield* settle(browserTools, browserSession, "browser_playwright_browser_snapshot", {})
      const captured = yield* settle(browserTools, browserSession, "browser_playwright_browser_take_screenshot", {
        filename: screenshot,
      })
      expect(inspected.output?.structured).toEqual({ url: fixtureUrl, text: "<h1>Verified fixture</h1>" })
      expect(captured.output?.structured).toEqual({ path: screenshot, url: fixtureUrl })
      expect(browserPack?.runtimes.find((runtime) => runtime.id === "playwright")?.command).toEqual([
        "npx",
        "-y",
        "@playwright/mcp@0.0.80",
        "--browser",
        "chromium",
        "--headless",
        "--isolated",
      ])
      expect((yield* Effect.promise(() => Bun.file(screenshot).arrayBuffer())).byteLength).toBe(
        screenshotPng.byteLength,
      )
      const browserSkill = yield* settle(browserTools, browserSession, "skill", { name: "browser-testing" })
      expect(browserSkill.output?.structured).toMatchObject({
        output: expect.stringContaining("Save a screenshot for the final verified state"),
      })

      const management = yield* registry.materialize(browserSession)
      yield* settle(management, browserSession, "capability_enable", { id: "research", profiles: ["default"] })
      const researchTools = yield* registry.materialize(browserSession)
      expect(names(researchTools)).toContain("research_context7_resolve-library-id")
      const found = yield* settle(researchTools, browserSession, "research_federated-research_search", {
        query: "fixture protocol revision",
      })
      const primaryUrl = new URL("/specification", page.url).toString()
      const fetched = yield* settle(researchTools, browserSession, "webfetch", {
        url: primaryUrl,
        format: "text",
      })
      expect(found.output?.structured).toMatchObject({
        results: [
          {
            id: "primary-1",
            title: "Fixture Protocol Specification",
            url: primaryUrl,
            publisher: "Fixture Standards Body",
            revised: "2026-09-01",
          },
        ],
      })
      expect(fetched.result).toEqual({ type: "text", value: "Normative fixture requirement: preserve citations." })
      const researchSkill = yield* settle(researchTools, browserSession, "skill", { name: "research" })
      expect(researchSkill.output?.structured).toMatchObject({
        output: expect.stringContaining("Fetch every decisive primary-source URL"),
      })
      const status = yield* settle(researchTools, browserSession, "capability_status", { id: "research" })
      expect(JSON.stringify(status)).not.toContain(secret)

      const enabled = yield* registry.materialize(browserSession)
      yield* settle(enabled, browserSession, "capability_disable", { id: "browser" })
      yield* settle(enabled, browserSession, "capability_disable", { id: "research" })
      yield* TestClock.adjust("31 seconds")
      yield* waitForFile(closeMarker)
      expect(yield* Effect.promise(() => Bun.file(closeMarker).exists())).toBe(true)
      const disabled = yield* registry.materialize(browserSession)
      expect(names(disabled)).not.toContain("browser_playwright_browser_navigate")
      expect(names(disabled)).not.toContain("research_federated-research_search")
    }).pipe(withTmpdirInstance()),
  )
})

const stringProperty = { type: "string" as const }
const screenshotPng = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
)

function adaptFixtureTransport(pack: CapabilityCatalog.Pack): CapabilityCatalog.Pack {
  if (pack.id !== "research" || !context7FixtureUrl) return pack
  return {
    ...pack,
    runtimes: pack.runtimes.map((runtime) =>
      runtime.id === "context7" ? { ...runtime, command: [context7FixtureUrl!] } : runtime,
    ),
  }
}

function tool(name: string, properties: Readonly<Record<string, object>>): Tool {
  return {
    name,
    description: `Fixture ${name}`,
    inputSchema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
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

function installNpxFixture(directory: string) {
  return Effect.promise(async () => {
    const bin = path.join(directory, "bin")
    const executable = path.join(bin, "npx")
    const fixture = path.join(import.meta.dir, "../fixture/capability-playwright-stdio.ts")
    await fs.mkdir(bin, { recursive: true })
    await Bun.write(
      executable,
      [
        `#!${process.execPath}`,
        'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["-y", "@playwright/mcp@0.0.80", "--browser", "chromium", "--headless", "--isolated"])) process.exit(64)',
        `await import(${JSON.stringify(fixture)})`,
      ].join("\n"),
    )
    await fs.chmod(executable, 0o755)
    return bin
  })
}

function waitForFile(file: string) {
  return Effect.promise(async () => {
    if (await Bun.file(file).exists()) return
    await new Promise<void>((resolve, reject) => {
      const watcher = watch(path.dirname(file), (_event, filename) => {
        if (filename !== path.basename(file)) return
        void Bun.file(file)
          .exists()
          .then((exists) => {
            if (!exists) return
            clearTimeout(timeout)
            watcher.close()
            resolve()
          }, reject)
      })
      const timeout = setTimeout(() => {
        watcher.close()
        reject(new Error(`Timed out waiting for ${file}`))
      }, 2_000)
    })
  })
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
  authorization?: string,
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
      const server = Bun.serve({
        port: 0,
        fetch: (request) =>
          authorization && request.headers.get("authorization") !== authorization
            ? new Response("Unauthorized", { status: 401 })
            : transport.handleRequest(request),
      })
      return {
        url: server.url.toString(),
        close: async () => {
          await protocol.close().catch(() => undefined)
          void server.stop(true)
        },
      }
    }),
    (fixture) => Effect.promise(fixture.close),
  )
}
