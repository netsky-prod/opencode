import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

describe("fork install script", () => {
  test("contains only fork GitHub release endpoints", async () => {
    const script = await Bun.file(path.resolve(import.meta.dir, "../../../../install")).text()
    expect(script).toContain("github.com/netsky-prod/opencode/releases")
    expect(script).toContain("api.github.com/repos/$REPOSITORY/releases?per_page=1")
    expect(script).toContain('url="https://github.com/$REPOSITORY/releases/download/v${specific_version}/$filename"')
    expect(script).not.toContain('url="https://github.com/$REPOSITORY/releases/latest/download/$filename"')
    expect(script).not.toContain("github.com/anomalyco/opencode/releases")
    expect(script).toContain("linux-x64|linux-arm64|darwin-x64|darwin-arm64)")
    expect(script).not.toContain("windows-x64)")
    expect(script).not.toContain('target="$target-musl"')
  })

  test("installs a supplied binary into an isolated HOME", async () => {
    await using dir = await tmpdir()
    const binary = path.join(dir.path, "fixture-opencode")
    await Bun.write(binary, "#!/bin/sh\necho fork\n")
    await $`chmod +x ${binary}`
    await $`HOME=${dir.path} bash ../../../../install --binary ${binary} --no-modify-path`.cwd(import.meta.dir)
    expect(await Bun.file(path.join(dir.path, ".opencode/bin/opencode")).exists()).toBe(true)
  })
})
