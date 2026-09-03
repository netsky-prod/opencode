import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"

const browserFixture = {
  id: "browser",
  version: 1,
  description: "Inspect web applications in a browser.",
  platforms: ["darwin", "linux"],
  skills: [
    {
      name: "browser-testing",
      description: "Inspect browser state and console output.",
      path: "browser-testing.md",
    },
  ],
  runtimes: [
    {
      id: "playwright",
      type: "mcp",
      command: ["npx", "-y", "@playwright/mcp@0.0.80"],
    },
  ],
  profiles: {
    default: {
      description: "Browse and inspect applications.",
      skills: ["browser-testing"],
      runtimes: ["playwright"],
    },
  },
}

const decode = (input: unknown) => Effect.runSync(CapabilityManifest.decode(input))

describe("CapabilityManifest", () => {
  test("decodes a pinned browser manifest and rejects unknown fields", () => {
    expect(String(decode(browserFixture).id)).toBe("browser")
    expect(() => decode({ ...browserFixture, typo: true })).toThrow()
  })

  test("rejects invalid IDs, missing profiles, and duplicate runtime IDs", () => {
    const invalidFixtures = [
      { ...browserFixture, id: "Browser" },
      { ...browserFixture, profiles: {} },
      { ...browserFixture, runtimes: [...browserFixture.runtimes, { ...browserFixture.runtimes[0] }] },
    ]
    for (const fixture of invalidFixtures) expect(() => decode(fixture)).toThrow()
  })

  test("rejects profile references and skill paths outside their manifest", () => {
    expect(() => decode({ ...browserFixture, profiles: { default: { ...browserFixture.profiles.default, skills: ["missing"] } } })).toThrow()
    expect(() => decode({ ...browserFixture, skills: [{ ...browserFixture.skills[0], path: "../outside.md" }] })).toThrow()
  })

  test("canonicalizes runtime tool names using pack and runtime IDs", () => {
    expect(CapabilityManifest.canonicalName("browser", "playwright", "navigate")).toBe("browser_playwright_navigate")
  })

  test("rejects colliding manifest-owned static tool names", () => {
    expect(() =>
      decode({
        ...browserFixture,
        runtimes: [{ ...browserFixture.runtimes[0], tools: ["navigate", "navigate"] }],
      }),
    ).toThrow("Canonical tool name collision")
  })

  test("decodes strict dependency definitions", () => {
    const manifest = decode({
      ...browserFixture,
      dependencies: [{ id: "node", check: ["node", "--version"] }],
    })
    expect(JSON.parse(JSON.stringify(manifest.dependencies))).toEqual([
      { id: "node", check: ["node", "--version"], optional: false },
    ])
    expect(() =>
      decode({ ...browserFixture, dependencies: [{ id: "node", check: ["node", "--version"], typo: true }] }),
    ).toThrow()
  })
})
