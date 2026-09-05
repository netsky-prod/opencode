import path from "node:path"
import fs from "node:fs/promises"
import { expect, test } from "bun:test"
import { parse } from "jsonc-parser"
import { CapabilityStore } from "../../src/capability/store"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "../fixture/fixture"

test("MCP edits preserve JSONC, omitted credentials, scope and reject stale revisions", async () => {
  await using tmp = await tmpdir()
  const globalDirectory = path.join(tmp.path, "global")
  const projectDirectory = path.join(tmp.path, "project")
  await Bun.write(
    path.join(globalDirectory, "opencode.jsonc"),
    '{\n // keep this comment\n "model": "private/model", "mcp": {"remote": {"type":"remote","url":"https://example.com/mcp/test-only-bearer-secret?token=test-only-bearer-secret","headers":{"Authorization":"test-only-bearer-secret"},"oauth":false}}\n}',
  )
  const store = CapabilityStore.make({ globalDirectory, projectDirectory })
  const first = await store.inventory()
  expect(JSON.stringify(first)).not.toContain("test-only-bearer-secret")
  await expect(
    store.save({
      name: "remote",
      scope: "global",
      revision: first.configRevisions.global,
      exposure: "always-on",
      config: { type: "remote", timeout: 1200 },
    }),
  ).rejects.toThrow("Confirm")
  const saved = await store.save({
    name: "remote",
    scope: "global",
    revision: first.configRevisions.global,
    exposure: "always-on",
    confirmExposureChange: true,
    config: { type: "remote", timeout: 1200 },
  })
  expect(saved.headerKeys).toEqual(["Authorization"])
  const text = await Bun.file(path.join(globalDirectory, "opencode.jsonc")).text()
  expect(text).toContain("// keep this comment")
  expect(parse(text)).toMatchObject({
    model: "private/model",
    mcp: { remote: { headers: { Authorization: "test-only-bearer-secret" }, timeout: 1200 } },
  })
  await expect(
    store.save({
      name: "remote",
      scope: "global",
      revision: first.configRevisions.global,
      exposure: "always-on",
      config: { type: "remote", timeout: 2000 },
    }),
  ).rejects.toThrow("changed")
  const second = await store.inventory()
  await store.save({
    name: "local",
    scope: "project",
    revision: second.configRevisions.project,
    exposure: "pack-only",
    config: { type: "local", command: ["node", "server.js"], environment: { TOKEN: "local-secret" } },
  })
  expect(await Bun.file(path.join(globalDirectory, "opencode.jsonc")).text()).toBe(text)
  expect(parse(await Bun.file(path.join(projectDirectory, "opencode.jsonc")).text())).toMatchObject({
    mcp: { local: { exposure: "pack-only", environment: { TOKEN: "local-secret" } } },
  })
})

test("attachment writes only a reference and requires explicit migration confirmation", async () => {
  await using tmp = await tmpdir()
  const store = CapabilityStore.make({ globalDirectory: path.join(tmp.path, "global"), projectDirectory: tmp.path })
  const inventory = await store.inventory()
  await store.save({
    name: "browser",
    scope: "global",
    revision: inventory.configRevisions.global,
    exposure: "always-on",
    config: { type: "remote", url: "https://example.com/mcp", headers: { Authorization: "test-only-bearer-secret" } },
  })
  await expect(
    store.attach({
      name: "browser",
      scope: "project",
      packID: "browser-pack",
      profile: "default",
      revision: "",
      mcpRevision: (await store.resolve("browser")).doc.revision,
    }),
  ).rejects.toThrow("Confirm")
  const result = await store.attach({
    name: "browser",
    scope: "project",
    packID: "browser-pack",
    profile: "default",
    revision: "",
    mcpRevision: (await store.resolve("browser")).doc.revision,
    confirmExposureChange: true,
  })
  expect(result).toMatchObject({ id: "browser-pack", reference: "browser", exposure: "pack-only" })
  const manifest = await Bun.file(path.join(tmp.path, ".opencode/capabilities/browser-pack/capability.json")).text()
  expect(manifest).not.toContain("test-only-bearer-secret")
  expect(JSON.parse(manifest).runtimes).toEqual([expect.objectContaining({ id: "browser", mcp: "browser" })])
  expect((await store.inventory()).mcps[0].exposure).toBe("pack-only")
  await expect(
    store.attach({
      name: "browser",
      scope: "project",
      packID: "../escape",
      profile: "default",
      revision: "",
      mcpRevision: "",
    }),
  ).rejects.toThrow("name")
})

test("inventory includes layered legacy config files and edits the originating file", async () => {
  await using tmp = await tmpdir()
  const globalDirectory = path.join(tmp.path, "global")
  await Bun.write(
    path.join(globalDirectory, "config.json"),
    JSON.stringify({ mcp: { legacy: { type: "local", command: ["node", "legacy.js"] } } }),
  )
  await Bun.write(path.join(globalDirectory, "opencode.jsonc"), '{ // modern preferences\n "model": "test/model" }')
  const store = CapabilityStore.make({ globalDirectory, projectDirectory: tmp.path })
  const inventory = await store.inventory()
  expect(inventory.mcps.map((entry) => entry.name)).toEqual(["legacy"])
  await store.save({
    name: "legacy",
    scope: "global",
    revision: inventory.mcps[0].revision,
    exposure: "always-on",
    confirmExposureChange: true,
    config: { type: "local", timeout: 900 },
  })
  expect(JSON.parse(await Bun.file(path.join(globalDirectory, "config.json")).text()).mcp.legacy.timeout).toBe(900)
  expect(await Bun.file(path.join(globalDirectory, "opencode.jsonc")).text()).toContain("// modern preferences")
})

test("pack attachment refuses a directory symlink escape without writing outside the project", async () => {
  await using tmp = await tmpdir()
  const globalDirectory = path.join(tmp.path, "global")
  const projectDirectory = path.join(tmp.path, "project")
  const outside = path.join(tmp.path, "outside")
  await fs.mkdir(projectDirectory)
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(projectDirectory, ".opencode"))
  const store = CapabilityStore.make({ globalDirectory, projectDirectory })
  const inventory = await store.inventory()
  await store.save({
    name: "local",
    scope: "global",
    revision: inventory.configRevisions.global,
    exposure: "pack-only",
    config: { type: "local", command: ["node", "server.js"] },
  })
  await expect(
    store.attach({
      name: "local",
      scope: "project",
      packID: "test",
      profile: "default",
      revision: "",
      mcpRevision: (await store.resolve("local")).doc.revision,
    }),
  ).rejects.toThrow("symbolic")
  expect(await fs.readdir(outside)).toEqual([])
})

test("standard .opencode configuration wins and shadowed global attachment cannot mutate the project MCP", async () => {
  await using tmp = await tmpdir()
  const globalDirectory = path.join(tmp.path, "global")
  const projectDirectory = path.join(tmp.path, "project")
  await Bun.write(
    path.join(globalDirectory, "opencode.json"),
    JSON.stringify({ mcp: { browser: { type: "local", command: ["global"] } } }),
  )
  await Bun.write(
    path.join(projectDirectory, "opencode.json"),
    JSON.stringify({ mcp: { browser: { type: "local", command: ["root"] } } }),
  )
  const nested = path.join(projectDirectory, ".opencode/opencode.jsonc")
  await Bun.write(
    nested,
    '{ // nested wins\n "mcp":{"browser":{"type":"local","command":["nested"],"environment":{"KEY":"project-secret"}}}}',
  )
  const store = CapabilityStore.make({ globalDirectory, projectDirectory })
  const inventory = await store.inventory()
  expect(inventory.mcps.find((entry) => entry.scope === "project")?.command).toEqual(["nested"])
  expect((await store.resolve("browser", "global")).config).toMatchObject({ command: ["global"] })
  const before = await Bun.file(nested).text()
  await expect(
    store.attach({
      name: "browser",
      mcpScope: "global",
      mcpRevision: (await store.resolve("browser", "global")).doc.revision,
      scope: "project",
      packID: "browser-pack",
      profile: "default",
      revision: "",
      confirmExposureChange: true,
    }),
  ).rejects.toThrow("shadowed")
  expect(await Bun.file(nested).text()).toBe(before)
  await store.save({
    name: "browser",
    scope: "project",
    revision: inventory.mcps.find((entry) => entry.scope === "project")!.revision,
    exposure: "always-on",
    confirmExposureChange: true,
    config: { type: "local", timeout: 400 },
  })
  expect(parse(await Bun.file(nested).text()).mcp.browser.timeout).toBe(400)
  expect(
    JSON.parse(await Bun.file(path.join(projectDirectory, "opencode.json")).text()).mcp.browser.timeout,
  ).toBeUndefined()
})

test("attaching to an existing profile retains its platform restrictions and other profiles", async () => {
  await using tmp = await tmpdir()
  const store = CapabilityStore.make({ globalDirectory: path.join(tmp.path, "global"), projectDirectory: tmp.path })
  await store.save({
    name: "local",
    scope: "project",
    revision: "",
    exposure: "pack-only",
    config: { type: "local", command: ["node"] },
  })
  const file = path.join(tmp.path, ".opencode/capabilities/custom/capability.json")
  await Bun.write(
    file,
    JSON.stringify({
      id: "custom",
      version: 1,
      description: "Custom",
      platforms: ["darwin", "linux"],
      skills: [],
      runtimes: [],
      profiles: {
        restricted: { description: "Linux only", platforms: ["linux"], skills: [], runtimes: [] },
        other: { description: "Other", skills: [], runtimes: [] },
      },
    }),
  )
  await store.attach({
    name: "local",
    mcpScope: "project",
    mcpRevision: (await store.resolve("local", "project")).doc.revision,
    scope: "project",
    packID: "custom",
    profile: "restricted",
    revision: await store.packRevision("project", "custom"),
  })
  expect(JSON.parse(await Bun.file(file).text()).profiles).toMatchObject({
    restricted: { platforms: ["linux"], runtimes: ["local"] },
    other: { description: "Other", runtimes: [] },
  })
})

test("attachment rejects a MCP changed after inventory was displayed", async () => {
  await using tmp = await tmpdir()
  const store = CapabilityStore.make({ globalDirectory: path.join(tmp.path, "global"), projectDirectory: tmp.path })
  const saved = await store.save({
    name: "local",
    scope: "project",
    revision: "",
    exposure: "pack-only",
    config: { type: "local", command: ["node"] },
  })
  await store.save({
    name: "local",
    scope: "project",
    revision: saved.revision,
    exposure: "pack-only",
    config: { type: "local", timeout: 500 },
  })
  await expect(
    store.attach({
      name: "local",
      scope: "project",
      packID: "custom",
      profile: "default",
      revision: "",
      mcpRevision: saved.revision,
    }),
  ).rejects.toThrow("changed")
  expect(await Bun.file(path.join(tmp.path, ".opencode/capabilities/custom/capability.json")).exists()).toBe(false)
})

test("manager writes honor a live process-safe file lease", async () => {
  await using tmp = await tmpdir()
  const store = CapabilityStore.make({ globalDirectory: path.join(tmp.path, "global"), projectDirectory: tmp.path })
  const file = path.join(tmp.path, "opencode.jsonc")
  const operation = {
    name: "local",
    scope: "project" as const,
    revision: "",
    exposure: "pack-only" as const,
    config: { type: "local" as const, command: ["node"] },
  }
  const lease = await Flock.acquire(`capability-manager:${file}`, { dir: tmp.path })
  const pending = store.save(operation)
  try {
    expect(await Promise.race([pending.then(() => "wrote"), Bun.sleep(200).then(() => "held")])).toBe("held")
    expect(await Bun.file(file).exists()).toBe(false)
  } finally {
    await lease.release()
    await pending
  }
  expect((await store.inventory()).mcps[0].name).toBe("local")
})

test("concurrent processes reclaim an expired manager lease without accepting stale writes", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "opencode.jsonc")
  const lock = path.join(tmp.path, Hash.fast(`capability-manager:${file}`) + ".lock")
  await fs.mkdir(lock)
  await Bun.write(path.join(lock, "heartbeat"), "")
  await Bun.write(path.join(lock, "meta.json"), JSON.stringify({ token: "exited-owner", pid: 0 }))
  const expired = new Date(Date.now() - 120_000)
  await fs.utimes(path.join(lock, "heartbeat"), expired, expired)
  const workers = Array.from({ length: 8 }, (_, index) =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        `
    import { CapabilityStore } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/capability/store.ts"))};
    const store = CapabilityStore.make(${JSON.stringify({ globalDirectory: path.join(tmp.path, "global"), projectDirectory: tmp.path })});
    try {
      await store.save({ name: "writer${index}", scope: "project", revision: "", exposure: "pack-only", config: { type: "local", command: ["node"] } });
      process.exit(0);
    } catch (error) { process.exit(error.message.includes("changed") ? 2 : 3); }
  `,
      ],
      { stdout: "ignore", stderr: "pipe" },
    ),
  )
  const outcomes = await Promise.all(workers.map((worker) => worker.exited))
  expect(outcomes.filter((code) => code === 0)).toHaveLength(1)
  expect(outcomes.filter((code) => code === 2)).toHaveLength(7)
  expect(Object.keys(JSON.parse(await Bun.file(file).text()).mcp)).toHaveLength(1)
  expect(await fs.stat(lock).catch(() => undefined)).toBeUndefined()
}, 15_000)
