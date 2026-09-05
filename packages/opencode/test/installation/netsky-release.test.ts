import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "fs/promises"
import { tmpdir } from "../fixture/fixture"

const script = path.resolve(import.meta.dir, "../../../../script/netsky-release.ts")
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]

async function run(version: string, directory: string) {
  const child = Bun.spawn([process.execPath, script, version, directory], { stdout: "pipe", stderr: "pipe" })
  return { code: await child.exited, stderr: await new Response(child.stderr).text() }
}

describe("Netsky release packaging", () => {
  test("packages each supported binary and publishes independently verifiable checksums", async () => {
    await using dir = await tmpdir()
    for (const target of targets) {
      const binary = path.join(dir.path, `netsky-${target}`, "bin/netsky")
      await mkdir(path.dirname(binary), { recursive: true })
      await Bun.write(binary, `fixture binary for ${target}\n`)
    }
    expect(await run("0.1.0", dir.path)).toEqual({ code: 0, stderr: "" })
    const manifest = await Bun.file(path.join(dir.path, "release.json")).json()
    expect(manifest.version).toBe("0.1.0")
    expect(manifest.assets.map((asset: { name: string }) => asset.name)).toEqual([
      "netsky-darwin-arm64.zip",
      "netsky-darwin-x64.zip",
      "netsky-linux-arm64.tar.gz",
      "netsky-linux-x64.tar.gz",
    ])
    const checksums = await Bun.file(path.join(dir.path, "SHA256SUMS")).text()
    for (const asset of manifest.assets) {
      const archive = path.join(dir.path, asset.name)
      const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex")
      expect(asset.sha256).toBe(digest)
      expect(checksums).toContain(`${digest}  ${asset.name}\n`)
      const listing = Bun.spawn(asset.name.endsWith("zip") ? ["unzip", "-Z1", archive] : ["tar", "-tzf", archive], {
        stdout: "pipe",
      })
      expect((await new Response(listing.stdout).text()).trim()).toBe("netsky")
      expect(await listing.exited).toBe(0)
    }
  })

  test("rejects invalid versions and incomplete platform sets without a release manifest", async () => {
    await using dir = await tmpdir()
    expect((await run("../bad-tag", dir.path)).code).not.toBe(0)
    expect((await run("0.1.0", dir.path)).code).not.toBe(0)
    expect(await Bun.file(path.join(dir.path, "release.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(dir.path, "SHA256SUMS")).exists()).toBe(false)
  })
})
