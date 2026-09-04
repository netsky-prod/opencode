import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CapabilityCatalog } from "@opencode-ai/core/capability/catalog"
import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { tmpdir } from "../fixture/tmpdir"

const browser = {
  id: "browser",
  version: 1,
  description: "Inspect browser pages and console output.",
  platforms: ["darwin", "linux"],
  skills: [{ name: "browser-testing", description: "Inspect browser console failures.", path: "browser-testing.md" }],
  runtimes: [{ id: "playwright", type: "mcp", command: ["npx", "@playwright/mcp@0.0.80"] }],
  dependencies: [{ id: "chromium", check: ["chromium", "--version"] }],
  profiles: {
    default: { description: "Inspect browser pages.", skills: ["browser-testing"], runtimes: ["playwright"] },
  },
}

const research = {
  ...browser,
  id: "research",
  description: "Find and verify primary sources.",
  dependencies: [{ id: "primary-source", check: ["source-fetch", "--version"] }],
  profiles: { default: { description: "Search primary sources.", skills: ["browser-testing"], runtimes: ["playwright"] } },
}

const decode = (manifest: unknown) => Effect.runSync(CapabilityManifest.decode(manifest))

describe("CapabilityCatalog", () => {
  test("project manifests replace global manifests which replace built-ins", async () => {
    await using tmp = await tmpdir()
    const globalDirectory = path.join(tmp.path, "global")
    const projectDirectory = path.join(tmp.path, "project")
    const builtinDirectory = path.join(tmp.path, "builtin", "research")
    await write(builtinDirectory, research)
    await write(path.join(globalDirectory, "research"), { ...research, description: "Global research." })
    await write(path.join(projectDirectory, ".opencode", "capabilities", "research"), {
      ...research,
      description: "Project research.",
    })
    const catalog = await Effect.runPromise(
      CapabilityCatalog.make({
        builtins: [{ manifest: decode(research), directory: builtinDirectory }],
        globalDirectory,
        projectDirectory,
      }),
    )

    expect((await Effect.runPromise(catalog.list())).find((pack) => String(pack.id) === "research")?.source).toBe("project")
  })

  test("ranks IDs, descriptions, profiles, runtimes, dependencies, and skill summaries deterministically", async () => {
    await using tmp = await tmpdir()
    const researchDirectory = path.join(tmp.path, "research")
    const browserDirectory = path.join(tmp.path, "browser")
    await write(researchDirectory, research)
    await write(browserDirectory, browser)
    const catalog = await Effect.runPromise(
      CapabilityCatalog.make({
        builtins: [
          { manifest: decode(research), directory: researchDirectory },
          { manifest: decode(browser), directory: browserDirectory },
        ],
        globalDirectory: path.join(tmp.path, "global"),
        projectDirectory: path.join(tmp.path, "project"),
      }),
    )

    expect(String((await Effect.runPromise(catalog.search("inspect browser console", new Set())))[0]?.id)).toBe("browser")
  })

  test("rejects a skill symlink that resolves outside its manifest directory", async () => {
    await using tmp = await tmpdir()
    const projectDirectory = path.join(tmp.path, "project")
    const packDirectory = path.join(projectDirectory, ".opencode", "capabilities", "browser")
    const outside = path.join(tmp.path, "outside.md")
    await fs.mkdir(packDirectory, { recursive: true })
    await fs.writeFile(outside, "outside")
    await fs.symlink(outside, path.join(packDirectory, "browser-testing.md"))
    await fs.writeFile(path.join(packDirectory, "capability.json"), JSON.stringify(browser))
    const catalog = await Effect.runPromise(
      CapabilityCatalog.make({ globalDirectory: path.join(tmp.path, "global"), projectDirectory }),
    )

    await expect(Effect.runPromise(catalog.list())).rejects.toThrow("Skill path escapes capability manifest")
  })

  test("ranks a one-character fuzzy ID match", async () => {
    await using tmp = await tmpdir()
    const browserDirectory = path.join(tmp.path, "browser")
    await write(browserDirectory, browser)
    const catalog = await Effect.runPromise(
      CapabilityCatalog.make({
        builtins: [{ manifest: decode(browser), directory: browserDirectory }],
        globalDirectory: path.join(tmp.path, "global"),
        projectDirectory: path.join(tmp.path, "project"),
      }),
    )

    expect(String((await Effect.runPromise(catalog.search("browzer", new Set())))[0]?.id)).toBe("browser")
  })

  test("ranks dependency IDs and checks", async () => {
    await using tmp = await tmpdir()
    const researchDirectory = path.join(tmp.path, "research")
    const browserDirectory = path.join(tmp.path, "browser")
    await write(researchDirectory, research)
    await write(browserDirectory, browser)
    const catalog = await Effect.runPromise(
      CapabilityCatalog.make({
        builtins: [
          { manifest: decode(research), directory: researchDirectory },
          { manifest: decode(browser), directory: browserDirectory },
        ],
        globalDirectory: path.join(tmp.path, "global"),
        projectDirectory: path.join(tmp.path, "project"),
      }),
    )

    expect(String((await Effect.runPromise(catalog.search("chromium version", new Set())))[0]?.id)).toBe("browser")
  })

  test("ignores capability directories without a manifest", async () => {
    await using tmp = await tmpdir()
    const globalDirectory = path.join(tmp.path, "global")
    await fs.mkdir(path.join(globalDirectory, "incomplete"), { recursive: true })
    const catalog = await Effect.runPromise(
      CapabilityCatalog.make({ globalDirectory, projectDirectory: path.join(tmp.path, "project") }),
    )

    expect(await Effect.runPromise(catalog.list())).toEqual([])
  })

  test("loads embedded skill content without a source-tree directory", async () => {
    await using tmp = await tmpdir()
    const catalog = await Effect.runPromise(
      CapabilityCatalog.make({
        builtins: [
          {
            manifest: decode(browser),
            directory: "/builtin/capabilities/browser",
            skills: { "browser-testing.md": "# Embedded browser testing" },
          },
        ],
        globalDirectory: path.join(tmp.path, "global"),
        projectDirectory: path.join(tmp.path, "project"),
      }),
    )

    expect(await Effect.runPromise(catalog.get("browser"))).toMatchObject({
      source: "builtin",
      directory: "/builtin/capabilities/browser",
      skills: [
        {
          location: "/builtin/capabilities/browser/browser-testing.md",
          content: "# Embedded browser testing",
        },
      ],
    })
  })
})

async function write(directory: string, manifest: unknown) {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "capability.json"), JSON.stringify(manifest))
  if (!manifest || typeof manifest !== "object" || !("skills" in manifest) || !Array.isArray(manifest.skills)) return
  await Promise.all(
    manifest.skills.map(async (skill) => {
      if (!skill || typeof skill !== "object" || !("path" in skill) || typeof skill.path !== "string") return
      const location = path.join(directory, skill.path)
      await fs.mkdir(path.dirname(location), { recursive: true })
      await fs.writeFile(location, "# skill")
    }),
  )
}
