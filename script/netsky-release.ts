#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { mkdtemp, rename, rm } from "fs/promises"
import semver from "semver"

const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]

async function prepare() {
  const version = process.argv[2]
  if (!version || semver.valid(version) !== version) throw new Error("Provide an exact semantic version, e.g. 0.1.0")
  const directory = path.resolve(process.argv[3] ?? "packages/opencode/dist")
  const root = path.resolve(import.meta.dir, "..")
  for (const target of targets) {
    const binary = Bun.file(path.join(directory, `netsky-${target}`, "bin/netsky"))
    if (!(await binary.exists()) || binary.size === 0) throw new Error(`Missing binary: netsky-${target}/bin/netsky`)
  }
  const staging = await mkdtemp(path.join(directory, ".netsky-release-"))
  try {
    const assets = []
    for (const target of targets) {
      const name = `netsky-${target}.${target.startsWith("darwin") ? "zip" : "tar.gz"}`
      const archive = path.join(staging, name)
      const bin = path.join(directory, `netsky-${target}`, "bin")
      if (target.startsWith("darwin"))
        await $`zip -q -j ${archive} ${path.join(bin, "netsky")} ${path.join(root, "LICENSE")}`.quiet()
      if (target.startsWith("linux")) await $`tar -czf ${archive} -C ${bin} netsky -C ${root} LICENSE`.quiet()
      const file = Bun.file(archive)
      const hash = new Bun.CryptoHasher("sha256")
      for await (const chunk of file.stream()) hash.update(chunk)
      assets.push({ name, platform: target, bytes: file.size, sha256: hash.digest("hex") })
    }
    await Bun.write(
      path.join(staging, "release.json"),
      JSON.stringify({ name: "Netsky Code", version, assets }, null, 2) + "\n",
    )
    const manifestHash = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(path.join(staging, "release.json")).arrayBuffer())
      .digest("hex")
    await Bun.write(
      path.join(staging, "SHA256SUMS"),
      assets.map((asset) => `${asset.sha256}  ${asset.name}\n`).join("") + `${manifestHash}  release.json\n`,
    )
    for (const name of [...assets.map((asset) => asset.name), "release.json", "SHA256SUMS"]) {
      await rename(path.join(staging, name), path.join(directory, name))
    }
    console.log(`Prepared Netsky Code ${version}: ${assets.length} archives, release.json, SHA256SUMS`)
  } finally {
    // Only this invocation's mkdtemp-owned staging directory is removed.
    await rm(staging, { recursive: true, force: true })
  }
}

await prepare().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
