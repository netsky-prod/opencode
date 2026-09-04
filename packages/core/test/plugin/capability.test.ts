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
})
