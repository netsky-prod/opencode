import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { CapabilityCatalog } from "@opencode-ai/core/capability/catalog"
import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { CapabilityState } from "@opencode-ai/core/capability/state"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { tmpdir } from "../fixture/tmpdir"

const browser = {
  id: "browser",
  version: 1,
  description: "Inspect browser pages and console output.",
  platforms: ["darwin", "linux"],
  skills: [{ name: "browser-testing", description: "Inspect browser console failures.", path: "browser-testing.md" }],
  runtimes: [{ id: "playwright", type: "mcp", command: ["npx", "@playwright/mcp@0.0.80"] }],
  profiles: {
    default: { description: "Inspect browser pages.", skills: ["browser-testing"], runtimes: ["playwright"] },
    diagnostics: { description: "Inspect browser diagnostics.", skills: ["browser-testing"], runtimes: ["playwright"] },
  },
}

const first = SessionV2.ID.make("ses_capability_first")
const second = SessionV2.ID.make("ses_capability_second")

describe("CapabilityState", () => {
  test("activation survives a service restart and is isolated by session", async () => {
    await withState(async ({ state, makeState }) => {
      await Effect.runPromise(state.enable({ sessionID: first, id: "browser", profiles: ["default"] }))

      const reopened = makeState()
      expect(await Effect.runPromise(reopened.list(first))).toEqual([
        { id: "browser", profiles: ["default"], state: "active" },
      ])
      expect(await Effect.runPromise(reopened.list(second))).toEqual([])
    })
  })

  test("deleting a session cascades its capability rows", async () => {
    await withState(async ({ db, state }) => {
      await Effect.runPromise(state.enable({ sessionID: first, id: "browser", profiles: ["default"] }))
      await Effect.runPromise(db.delete(SessionTable).where(eq(SessionTable.id, first)).run())

      expect(await Effect.runPromise(state.list(first))).toEqual([])
    })
  })

  test("rejects unknown packs and profiles before changing stored activation", async () => {
    await withState(async ({ state }) => {
      await expect(Effect.runPromise(state.enable({ sessionID: first, id: "missing", profiles: ["default"] }))).rejects.toThrow(
        "Capability manifest not found: missing",
      )
      await expect(Effect.runPromise(state.enable({ sessionID: first, id: "browser", profiles: ["missing"] }))).rejects.toThrow(
        "Capability profile not found: browser/missing",
      )

      expect(await Effect.runPromise(state.list(first))).toEqual([])
    })
  })

  test("stores sorted unique profiles and the runtime-reported activation state", async () => {
    await withState(async ({ state }) => {
      await Effect.runPromise(
        state.enable({ sessionID: first, id: "browser", profiles: ["diagnostics", "default", "diagnostics"], state: "degraded" }),
      )

      expect(await Effect.runPromise(state.list(first))).toEqual([
        { id: "browser", profiles: ["default", "diagnostics"], state: "degraded" },
      ])
    })
  })

  test("disables only the selected session capability", async () => {
    await withState(async ({ state }) => {
      await Effect.runPromise(state.enable({ sessionID: first, id: "browser", profiles: ["default"] }))
      await Effect.runPromise(state.enable({ sessionID: second, id: "browser", profiles: ["diagnostics"] }))
      await Effect.runPromise(state.disable({ sessionID: first, id: "browser" }))

      expect(await Effect.runPromise(state.list(first))).toEqual([])
      expect(await Effect.runPromise(state.list(second))).toEqual([
        { id: "browser", profiles: ["diagnostics"], state: "active" },
      ])
    })
  })

  test("retains activations whose manifest has disappeared and reports them unavailable", async () => {
    await withState(async ({ capabilityDirectory, state }) => {
      await Effect.runPromise(state.enable({ sessionID: first, id: "browser", profiles: ["default"] }))
      await fs.rm(capabilityDirectory, { recursive: true, force: true })

      expect(await Effect.runPromise(state.list(first))).toEqual([
        { id: "browser", profiles: ["default"], state: "active" },
      ])
      expect(await Effect.runPromise(state.status(first))).toEqual([
        { id: "browser", profiles: ["default"], state: "unavailable" },
      ])
    })
  })
})

async function withState(
  callback: (input: {
    readonly db: Database.Interface["db"]
    readonly state: CapabilityState.Interface
    readonly makeState: () => CapabilityState.Interface
    readonly capabilityDirectory: string
  }) => Promise<void>,
) {
  await using temporary = await tmpdir()
  const projectDirectory = path.join(temporary.path, "project")
  const capabilityDirectory = path.join(projectDirectory, ".opencode", "capabilities", "browser")
  await write(capabilityDirectory, browser)
  const catalog = await Effect.runPromise(
    CapabilityCatalog.make({ globalDirectory: path.join(temporary.path, "global"), projectDirectory }),
  )
  const layer = Database.layerFromPath(path.join(temporary.path, "state.sqlite"))

  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* setup(database.db)
      const makeState = () => CapabilityState.make({ db: database.db, catalog })
      yield* Effect.promise(() => callback({ db: database.db, state: makeState(), makeState, capabilityDirectory }))
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}

function setup(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values([
        { id: first, project_id: Project.ID.global, slug: "first", directory: "/project", title: "first", version: "test" },
        { id: second, project_id: Project.ID.global, slug: "second", directory: "/project", title: "second", version: "test" },
      ])
      .run()
  })
}

async function write(directory: string, manifest: unknown) {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "capability.json"), JSON.stringify(manifest))
  const decoded = Effect.runSync(CapabilityManifest.decode(manifest))
  await Promise.all(decoded.skills.map((skill) => fs.writeFile(path.join(directory, skill.path), "# skill")))
}
