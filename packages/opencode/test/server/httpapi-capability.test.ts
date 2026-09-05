import path from "node:path"
import fs from "node:fs/promises"
import { expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Effect.promise(() => resetDatabase())
      yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer)),
)

it.instance(
  "human HTTP activation uses the durable session state without messages and rejects foreign locations",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const other = yield* tmpdirScoped({ git: true })
      const handler = HttpApiApp.webHandler()
      const request = (route: string, payload?: unknown, directory = tmp.directory) =>
        Effect.promise(async () => {
          const response = await handler.handler(
            new Request("http://localhost" + route, {
              method: payload === undefined ? "GET" : "POST",
              headers: { "x-opencode-directory": directory, "content-type": "application/json" },
              ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
            }),
            Context.empty() as Context.Context<unknown>,
          )
          return { status: response.status, body: await response.json() }
        })
      const first = yield* request("/session", {})
      const invalid = yield* request("/capability/mcp", {
        name: "invalid",
        scope: "project",
        revision: "",
        exposure: "pack-only",
        config: { type: "remote", url: "https://example.com/mcp", headers: "invalid-payload-secret" },
      })
      expect(invalid.status).toBe(400)
      expect(JSON.stringify(invalid.body)).not.toContain("invalid-payload-secret")
      const second = yield* request("/session", {})
      const sessionID = first.body.id
      expect(first.status).toBe(200)
      const enabled = yield* request("/capability/enable", { sessionID, id: "human-test", profiles: ["default"] })
      expect(enabled).toMatchObject({ status: 200, body: { state: "active", nextTurn: true } })
      const inventory = yield* request(`/capability?sessionID=${sessionID}`)
      expect(inventory.status).toBe(200)
      expect(inventory.body.packs.find((pack: { id: string }) => pack.id === "human-test")).toMatchObject({
        active: true,
        selectedProfiles: ["default"],
      })
      const isolated = yield* request(`/capability?sessionID=${second.body.id}`)
      expect(isolated.body.packs.find((pack: { id: string }) => pack.id === "human-test").active).toBe(false)
      expect((yield* request(`/session/${sessionID}/message`)).body).toEqual([])
      expect((yield* request("/capability/disable", { sessionID, id: "human-test" }, other)).status).toBe(400)
      expect(yield* request("/capability/disable", { sessionID, id: "human-test" })).toMatchObject({
        status: 200,
        body: { state: "disabled" },
      })
      const saved = yield* request("/capability/mcp", {
        name: "managed",
        scope: "project",
        revision: inventory.body.configRevisions.project,
        exposure: "always-on",
        confirmExposureChange: true,
        config: {
          type: "local",
          timeout: 4000,
        },
      })
      expect(saved).toMatchObject({ status: 200, body: { status: "connected" } })
      const checked = yield* request("/capability/mcp/check", { name: "managed", scope: "project" })
      expect(checked).toMatchObject({ status: 200, body: { state: "connected", tools: ["current_directory"] } })
      expect((yield* request("/mcp")).body).toEqual({ managed: { status: "connected" } })
      const failed = yield* request("/capability/mcp", {
        name: "unreachable",
        scope: "project",
        revision: saved.body.revision,
        exposure: "pack-only",
        config: {
          type: "remote",
          url: "http://127.0.0.1:9/mcp?token=http-secret",
          oauth: false,
          headers: { Authorization: "http-secret" },
          timeout: 50,
        },
      })
      expect(failed.status).toBe(200)
      const failure = yield* request("/capability/mcp/check", { name: "unreachable", scope: "project" })
      expect(failure).toMatchObject({ status: 200, body: { state: "failed" } })
      expect(JSON.stringify(failure)).not.toContain("http-secret")
      expect((yield* request("/mcp")).body.managed.status).toBe("connected")
      const attached = yield* request("/capability/mcp/attach", {
        name: "managed",
        mcpScope: "project",
        scope: "project",
        packID: "managed-pack",
        profile: "default",
        revision: "",
        mcpRevision: failed.body.revision,
        confirmExposureChange: true,
      })
      expect(attached).toMatchObject({ status: 200, body: { reference: "managed", exposure: "pack-only" } })
      const activated = yield* request("/capability/enable", { sessionID, id: "managed-pack", profiles: ["default"] })
      expect(activated).toMatchObject({ status: 200, body: { state: "active", tools: ["managed_current_directory"] } })
      expect((yield* request("/mcp")).body.managed).toEqual({ status: "disabled" })
      yield* Effect.promise(() =>
        fs.unlink(path.join(tmp.directory, ".opencode/capabilities/managed-pack/capability.json")),
      )
      const stale = yield* request(`/capability?sessionID=${sessionID}`)
      expect(stale.body.packs.find((pack: { id: string }) => pack.id === "managed-pack")).toMatchObject({
        state: "unavailable",
        source: "unavailable",
        active: true,
      })
      expect((yield* request("/capability/disable", { sessionID, id: "managed-pack" })).status).toBe(200)
      expect((yield* request(`/session/${sessionID}/message`)).body).toEqual([])
    }),
  {
    git: true,
    init: (directory) =>
      Effect.promise(async () => {
        const command = [
          process.execPath,
          "-e",
          `if (process.env.MANAGER_INHERITED_SECRET !== "inherited-secret") process.exit(1); await import(${JSON.stringify(path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts"))})`,
        ]
        await Bun.write(
          path.join(directory, "opencode.jsonc"),
          JSON.stringify({
            mcp: { managed: { type: "local", command, environment: { MANAGER_INHERITED_SECRET: "inherited-secret" } } },
          }),
        )
        await Bun.write(
          path.join(directory, ".opencode/opencode.jsonc"),
          JSON.stringify({ mcp: { managed: { type: "local", command } } }),
        )
        await Bun.write(
          path.join(directory, ".opencode/capabilities/human-test/capability.json"),
          JSON.stringify({
            id: "human-test",
            version: 1,
            description: "Human management fixture",
            platforms: ["darwin", "linux"],
            skills: [],
            runtimes: [],
            profiles: { default: { description: "Default", skills: [], runtimes: [] } },
          }),
        )
      }),
  },
  { timeout: 60000 },
)
