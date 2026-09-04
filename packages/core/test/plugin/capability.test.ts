import path from "path"
import { describe, expect } from "bun:test"
import { CapabilityCatalog } from "@opencode-ai/core/capability/catalog"
import { CapabilityPlugin } from "@opencode-ai/core/plugin/capability"
import { Effect, Layer } from "effect"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(Layer.empty)

describe("CapabilityPlugin.Plugin", () => {
  it.live("ships pinned browser and research profiles with evidence guidance", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (temporary) =>
        Effect.gen(function* () {
          const catalog = yield* CapabilityCatalog.make({
            globalDirectory: path.join(temporary.path, "global"),
            projectDirectory: path.join(temporary.path, "project"),
          })
          yield* CapabilityPlugin.Plugin.effect(host()).pipe(Effect.provideService(CapabilityCatalog.Service, catalog))

          const browser = yield* catalog.get("browser")
          const research = yield* catalog.get("research")
          expect(browser).toMatchObject({
            source: "builtin",
            profiles: { default: {}, diagnostics: {} },
            runtimes: [
              {
                id: "playwright",
                command: ["npx", "-y", "@playwright/mcp@0.0.80", "--browser", "chromium", "--headless", "--isolated"],
              },
              { id: "chrome-devtools", command: ["npx", "-y", "chrome-devtools-mcp@1.8.0"] },
            ],
          })
          expect(research).toMatchObject({
            source: "builtin",
            profiles: { default: {} },
          })
          expect(research?.runtimes.map((runtime) => String(runtime.id))).toEqual(["federated-research", "context7"])
          expect(research?.runtimes.find((runtime) => runtime.id === "federated-research")?.command).toEqual([
            "${FEDERATED_RESEARCH_MCP_URL}",
          ])
          expect(research?.runtimes.find((runtime) => runtime.id === "federated-research")?.environment).toEqual({
            AUTHORIZATION: "${FEDERATED_RESEARCH_AUTHORIZATION}",
          })
          expect(research?.runtimes.find((runtime) => runtime.id === "context7")?.command).toEqual([
            "https://mcp.context7.com/mcp",
          ])
          expect(
            (yield* catalog.list())
              .flatMap((pack) => pack.runtimes)
              .flatMap((runtime) => Object.values(runtime.environment ?? {}))
              .every((value) => /^\$\{[A-Z][A-Z0-9_]*\}$/.test(value)),
          ).toBe(true)

          expect(browser?.skills.map((skill) => String(skill.name))).toEqual(["browser-testing"])
          expect(research?.skills.map((skill) => String(skill.name))).toEqual(["research"])
          expect(String(browser?.skills[0]?.location)).toBe("/builtin/capabilities/browser/browser-testing.md")
          expect(browser?.skills[0]?.content).toContain("Save a screenshot for the final verified state")
          expect(String(research?.skills[0]?.location)).toBe("/builtin/capabilities/research/research.md")
          expect(research?.skills[0]?.content).toContain("Fetch every decisive primary-source URL")
          expect(JSON.stringify(yield* catalog.list())).not.toContain("Bearer ")
        }),
      (temporary) => Effect.promise(() => temporary[Symbol.asyncDispose]()),
    ),
  )

  it.live("ships every operational profile with exact profile-scoped probes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (temporary) =>
        Effect.gen(function* () {
          const catalog = yield* CapabilityCatalog.make({
            globalDirectory: path.join(temporary.path, "global"),
            projectDirectory: path.join(temporary.path, "project"),
          })
          yield* CapabilityPlugin.Plugin.effect(host()).pipe(Effect.provideService(CapabilityCatalog.Service, catalog))

          const packs = yield* catalog.list()
          expect(packs.map((pack) => String(pack.id))).toEqual([
            "browser",
            "deploy",
            "documents",
            "github",
            "mobile",
            "research",
            "security",
          ])
          expect(Object.keys((yield* catalog.get("mobile"))!.profiles).toSorted()).toEqual(["android", "ios"])
          expect(Object.keys((yield* catalog.get("security"))!.profiles).toSorted()).toEqual(["dynamic", "static"])
          expect(Object.keys((yield* catalog.get("documents"))!.profiles)).toEqual(["default"])
          expect(Object.keys((yield* catalog.get("github"))!.profiles)).toEqual(["default"])
          expect(Object.keys((yield* catalog.get("deploy"))!.profiles).toSorted()).toEqual([
            "cloudflare",
            "core",
            "runpod",
          ])

          const profile = (id: string, name: string) =>
            Object.entries(packs.find((pack) => pack.id === id)!.profiles).find(([profile]) => profile === name)?.[1]
          const probes = (id: string) =>
            (packs.find((pack) => pack.id === id)?.dependencies ?? []).map((dependency) => ({
              check: [...dependency.check],
              optional: dependency.optional,
              profiles: dependency.profiles?.map(String),
            }))
          expect(probes("mobile")).toEqual([
            { check: ["xcodebuild", "-version"], optional: true, profiles: ["ios"] },
            { check: ["xcrun", "simctl", "list", "-j"], optional: true, profiles: ["ios"] },
            { check: ["flutter", "--version"], optional: true, profiles: ["ios", "android"] },
            { check: ["adb", "version"], optional: true, profiles: ["android"] },
          ])
          expect(probes("security")).toEqual([
            { check: ["semgrep", "--version"], optional: true, profiles: ["static"] },
            { check: ["codeql", "version"], optional: true, profiles: ["static"] },
            { check: ["gitleaks", "version"], optional: true, profiles: ["static"] },
            { check: ["osv-scanner", "--version"], optional: true, profiles: ["static"] },
            { check: ["trivy", "--version"], optional: true, profiles: ["static"] },
            ...[
              ["zap.sh", "-version"],
              ["nuclei", "-version"],
              ["schemathesis", "--version"],
              ["nmap", "--version"],
              ["mitmproxy", "--version"],
              ["k6", "version"],
            ].map((check) => ({ check, optional: true, profiles: ["dynamic"] })),
          ])
          expect(probes("documents")).toEqual(
            [
              ["markitdown", "--version"],
              ["pdftotext", "-v"],
              ["tesseract", "--version"],
              ["ffmpeg", "-version"],
              ["ffprobe", "-version"],
            ].map((check) => ({ check, optional: true, profiles: ["default"] })),
          )
          expect(probes("github")).toEqual([
            { check: ["gh", "--version"], optional: true, profiles: ["default"] },
            { check: ["gh", "auth", "status"], optional: true, profiles: ["default"] },
          ])
          expect(probes("deploy")).toEqual([
            { check: ["docker", "version"], optional: true, profiles: ["core"] },
            { check: ["docker", "compose", "version"], optional: true, profiles: ["core"] },
            { check: ["runpodctl", "version"], optional: true, profiles: ["runpod"] },
            { check: ["wrangler", "--version"], optional: true, profiles: ["cloudflare"] },
          ])

          for (const pack of packs) {
            const skillIDs = new Set(pack.skills.map((skill) => skill.name))
            const runtimeIDs = new Set(pack.runtimes.map((runtime) => runtime.id))
            for (const profile of Object.values(pack.profiles)) {
              expect(profile.skills.every((skill) => skillIDs.has(skill))).toBe(true)
              expect(profile.runtimes.every((runtime) => runtimeIDs.has(runtime))).toBe(true)
            }
          }

          expect(profile("mobile", "ios")?.platforms).toEqual(["darwin"])
          expect(profile("mobile", "android")?.platforms).toEqual(["darwin", "linux"])
          for (const id of ["security", "deploy"]) {
            expect((yield* catalog.get(id))?.permissions?.hints?.every((hint) => hint.action === "bash")).toBe(true)
          }
          expect(JSON.stringify(packs)).not.toMatch(
            /(?:authorization|bearer|api[_-]?key|token)["']?\s*[:=]\s*["'][^$]/i,
          )
        }),
      (temporary) => Effect.promise(() => temporary[Symbol.asyncDispose]()),
    ),
  )
})
