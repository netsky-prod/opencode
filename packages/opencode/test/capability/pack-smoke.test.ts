import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import type { PluginContext } from "@opencode-ai/plugin/v2/effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CapabilityCatalog } from "@opencode-ai/core/capability/catalog"
import { CapabilityRuntime } from "@opencode-ai/core/capability/runtime"
import { CapabilityState } from "@opencode-ai/core/capability/state"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { CapabilityPlugin } from "@opencode-ai/core/plugin/capability"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillV2 } from "@opencode-ai/core/skill"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { CapabilityTool } from "@opencode-ai/core/tool/capability"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { DateTime, Effect, Layer } from "effect"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const sessionID = SessionV2.ID.make("ses_operational_pack_smoke")
const identity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_operational_pack_smoke"),
}
const activations = new Map<SessionV2.ID, CapabilityState.Activation[]>()
const permissionRequests: PermissionV2.AssertInput[] = []
const deniedCommands = new Set<string>()

const it = testEffect(Layer.empty)

describe("operational capability packs", () => {
  it.live(
    "reports a missing npx prerequisite even when Node is available",
    Effect.gen(function* () {
      reset()
      const test = yield* TestInstance
      const fixture = yield* installExecutables(test.directory, ["node", "npx"], new Set(["npx"]))
      yield* environment({
        PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        PROBE_MARKERS: fixture.markers,
      })
      const catalog = yield* makeCatalog(test.directory)
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* loadBuiltins(catalog)
          const registry = yield* ToolRegistry.Service
          const tools = yield* registry.materialize(sessionID)
          expect(yield* settle(tools, "capability_enable", { id: "browser", profiles: ["default"] })).toMatchObject({
            result: {
              type: "json",
              value: {
                state: "failed",
                dependencies: expect.arrayContaining([
                  expect.objectContaining({ id: "node", state: "available" }),
                  expect.objectContaining({ id: "npx", state: "missing" }),
                ]),
                remediation: expect.arrayContaining([expect.stringContaining("npx")]),
              },
            },
          })
          expect(activations.get(sessionID) ?? []).toEqual([])
        }).pipe(Effect.provide(makeLayer(test.directory, catalog))),
      )
    }).pipe(withTmpdirInstance()),
  )

  it.live(
    "uses real stub probes to report Linux iOS unsupported and Android degraded",
    Effect.gen(function* () {
      reset()
      const test = yield* TestInstance
      const fixture = yield* installExecutables(test.directory, ["flutter", "adb"], new Set(["adb"]))
      yield* environment({
        PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        PROBE_MARKERS: fixture.markers,
      })
      const catalog = yield* makeCatalog(test.directory)

      yield* withPlatform(
        "linux",
        Effect.scoped(
          Effect.gen(function* () {
            yield* loadBuiltins(catalog)
            const registry = yield* ToolRegistry.Service
            const status = yield* settle(yield* registry.materialize(sessionID), "capability_status", { id: "mobile" })
            expect(status).toMatchObject({
              result: { type: "json" },
              output: {
                structured: {
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
                        ios: expect.objectContaining({ state: "unsupported", dependencies: [] }),
                      },
                    }),
                  ],
                },
              },
            })
            expect((yield* markerArguments(fixture.markers)).toSorted()).toEqual([
              'adb:["version"]',
              'flutter:["--version"]',
            ])
          }).pipe(Effect.provide(makeLayer(test.directory, catalog))),
        ),
      )
    }).pipe(withTmpdirInstance()),
  )

  it.live(
    "loads pack guidance and retains oversized CLI output in the session artifact store",
    Effect.gen(function* () {
      reset()
      const test = yield* TestInstance
      const fixture = yield* installExecutables(test.directory, [
        "markitdown",
        "pdftotext",
        "tesseract",
        "ffmpeg",
        "ffprobe",
      ])
      yield* environment({
        PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        PROBE_MARKERS: fixture.markers,
      })
      const catalog = yield* makeCatalog(test.directory)

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* loadBuiltins(catalog)
          const registry = yield* ToolRegistry.Service
          const management = yield* registry.materialize(sessionID)
          expect(
            yield* settle(management, "capability_enable", { id: "documents", profiles: ["default"] }),
          ).toMatchObject({
            result: { type: "json", value: expect.objectContaining({ state: "active", profiles: ["default"] }) },
          })

          const tools = yield* registry.materialize(sessionID)
          expect(yield* settle(tools, "skill", { name: "document-analysis" })).toMatchObject({
            output: { structured: { output: expect.stringContaining("session tool-output artifact store") } },
          })
          const command = "markitdown fixture.docx"
          const extracted = yield* settle(tools, "bash", { command })
          expect(extracted.outputPaths).toHaveLength(1)
          expect(extracted.result).toMatchObject({ type: "text", value: expect.stringContaining("full content saved") })
          const outputPath = extracted.outputPaths?.[0]
          if (!outputPath) throw new Error("expected a retained document artifact")
          expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toContain(
            "DOCUMENT_FACT=capability-artifact",
          )
          expect(outputPath).toStartWith(path.join(test.directory, "data", "tool-output"))
          expect(permissionRequests).toContainEqual(
            expect.objectContaining({
              action: "bash",
              resources: [command],
              save: [command],
            }),
          )
        }).pipe(Effect.provide(makeLayer(test.directory, catalog))),
      )
    }).pipe(withTmpdirInstance()),
  )

  it.live(
    "keeps security dynamic and deploy execution behind the canonical bash permission",
    Effect.gen(function* () {
      reset()
      const test = yield* TestInstance
      const fixture = yield* installExecutables(test.directory, [
        "zap.sh",
        "nuclei",
        "schemathesis",
        "nmap",
        "mitmproxy",
        "k6",
        "docker",
      ])
      yield* environment({
        PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        PROBE_MARKERS: fixture.markers,
      })
      const catalog = yield* makeCatalog(test.directory)
      deniedCommands.add("nuclei -u http://127.0.0.1:9")
      deniedCommands.add("docker compose up")

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* loadBuiltins(catalog)
          const registry = yield* ToolRegistry.Service
          const management = yield* registry.materialize(sessionID)
          expect(
            yield* settle(management, "capability_enable", { id: "security", profiles: ["dynamic"] }),
          ).toMatchObject({ result: { type: "json", value: { state: "degraded", profiles: ["dynamic"] } } })
          expect(yield* settle(management, "capability_enable", { id: "deploy", profiles: ["core"] })).toMatchObject({
            result: { type: "json", value: { state: "active", profiles: ["core"] } },
          })
          const tools = yield* registry.materialize(sessionID)
          expect(yield* settle(tools, "skill", { name: "security-testing" })).toMatchObject({
            output: { structured: { output: expect.stringContaining("canonical permission action is `bash`") } },
          })
          expect(yield* settle(tools, "skill", { name: "deployment-verification" })).toMatchObject({
            output: { structured: { output: expect.stringContaining("canonical permission action is `bash`") } },
          })

          for (const command of deniedCommands) {
            expect(yield* settle(tools, "bash", { command })).toMatchObject({
              result: { type: "error", value: `Unable to execute command: ${command}` },
            })
          }
          expect(
            permissionRequests.filter((request) => request.action === "bash").map((request) => request.resources),
          ).toEqual([["nuclei -u http://127.0.0.1:9"], ["docker compose up"]])
          expect(yield* markerArguments(fixture.markers)).not.toContain('nuclei:["-u","http://127.0.0.1:9"]')
          expect(yield* markerArguments(fixture.markers)).not.toContain('docker:["compose","up"]')

          for (const id of ["security", "deploy"]) {
            const pack = yield* catalog.get(id)
            expect(pack?.permissions?.hints?.every((hint) => hint.action === "bash")).toBe(true)
            expect(
              pack?.permissions?.hints?.every((hint) => !/token|secret|password|authorization/i.test(hint.resource)),
            ).toBe(true)
            for (const hint of pack?.permissions?.hints ?? []) {
              expect(
                PermissionV2.evaluate(hint.action, hint.resource, [{ action: "bash", resource: "*", effect: "ask" }])
                  .effect,
              ).toBe("ask")
            }
          }
        }).pipe(Effect.provide(makeLayer(test.directory, catalog))),
      )
    }).pipe(withTmpdirInstance()),
  )
})

function reset() {
  activations.clear()
  permissionRequests.length = 0
  deniedCommands.clear()
}

function makeCatalog(directory: string) {
  return CapabilityCatalog.make({
    globalDirectory: path.join(directory, "global-capabilities"),
    projectDirectory: directory,
  })
}

function loadBuiltins(catalog: CapabilityCatalog.Interface) {
  return CapabilityPlugin.Plugin.effect({} as PluginContext).pipe(
    Effect.provideService(CapabilityCatalog.Service, catalog),
  )
}

function makeLayer(directory: string, catalog: CapabilityCatalog.Interface) {
  const root = AbsolutePath.make(directory)
  const location = Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory: root,
      workspaceID: Location.Ref.make({ directory: root }).workspaceID,
      project: { id: Project.ID.global, directory: root },
    }),
  )
  const state = Layer.succeed(
    CapabilityState.Service,
    CapabilityState.Service.of({
      list: (id) => Effect.succeed(activations.get(id) ?? []),
      status: (id) => Effect.succeed(activations.get(id) ?? []),
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
    }),
  )
  const runtime = Layer.mock(CapabilityRuntime.Service, {
    activate: () => Effect.succeed({ state: "active" as const, references: [] }),
    release: () => Effect.void,
    status: () => Effect.succeed({ state: "stopped" as const, references: 0, updatedAt: 0 }),
  })
  const permission = Layer.mock(PermissionV2.Service, {
    assert: (input) =>
      Effect.sync(() => permissionRequests.push(input)).pipe(
        Effect.andThen(
          input.action === "bash" && deniedCommands.has(input.resources[0] ?? "")
            ? Effect.fail(new PermissionV2.BlockedError({ rules: [] }))
            : Effect.void,
        ),
      ),
  })
  const agent = Layer.mock(AgentV2.Service, {
    resolve: () => Effect.succeed(AgentV2.Info.make(AgentV2.Info.empty(identity.agent))),
  })
  const sessions = Layer.mock(SessionStore.Service, {
    get: (id) =>
      Effect.succeed(
        SessionV2.Info.make({
          id,
          projectID: Project.ID.global,
          title: "operational pack smoke",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
          location: { directory: root },
        }),
      ),
  })
  const config = Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })
  const skills = Layer.mock(SkillV2.Service, { list: () => Effect.succeed([]) })
  return AppNodeBuilder.build(
    LayerNode.group([
      ApplicationTools.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      CapabilityTool.node,
      LocationMutation.node,
      BashTool.node,
      SkillTool.node,
    ]),
    [
      [CapabilityCatalog.node, Layer.succeed(CapabilityCatalog.Service, catalog)],
      [CapabilityState.node, state],
      [CapabilityRuntime.node, runtime],
      [Location.node, location],
      [PermissionV2.node, permission],
      [AgentV2.node, agent],
      [SessionStore.node, sessions],
      [Config.node, config],
      [SkillV2.node, skills],
      [Global.node, Global.layerWith({ data: path.join(directory, "data") })],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  )
}

function settle(materialization: ToolRegistry.Materialization, name: string, input: unknown) {
  return materialization.settle({
    sessionID,
    ...identity,
    call: { type: "tool-call", id: `call-${name}-${crypto.randomUUID()}`, name, input },
  })
}

function installExecutables(
  directory: string,
  names: ReadonlyArray<string>,
  failures: ReadonlySet<string> = new Set(),
) {
  return Effect.promise(async () => {
    const bin = path.join(directory, "bin")
    const markers = path.join(directory, "probe-markers")
    await fs.mkdir(bin, { recursive: true })
    await fs.mkdir(markers, { recursive: true })
    await Promise.all(
      names.map(async (name) => {
        const executable = path.join(bin, name)
        await Bun.write(
          executable,
          [
            `#!${process.execPath}`,
            'import path from "node:path"',
            "const args = process.argv.slice(2)",
            `const command = ${JSON.stringify(name)}`,
            'const marker = `${command}-${Buffer.from(JSON.stringify(args)).toString("hex")}`',
            "await Bun.write(path.join(process.env.PROBE_MARKERS, marker), JSON.stringify({ command, args }))",
            `if (${failures.has(name)}) process.exit(7)`,
            'if (command === "markitdown" && args[0] !== "--version") {',
            '  console.log("DOCUMENT_FACT=capability-artifact\\n" + "x".repeat(60 * 1024))',
            "} else console.log(`${command} fixture 1.0`)",
          ].join("\n"),
        )
        await fs.chmod(executable, 0o755)
      }),
    )
    return { bin, markers }
  })
}

function markerArguments(directory: string) {
  return Effect.promise(async () =>
    Promise.all(
      (await fs.readdir(directory)).map(async (entry) => {
        const value = (await Bun.file(path.join(directory, entry)).json()) as { command: string; args: string[] }
        return `${value.command}:${JSON.stringify(value.args)}`
      }),
    ),
  )
}

function environment(values: Readonly<Record<string, string>>) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
      Object.assign(process.env, values)
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )
}

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
