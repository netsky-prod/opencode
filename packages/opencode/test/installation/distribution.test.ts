import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

describe("Netsky Code distribution", () => {
  test("publishes Netsky Code 0.1.0 with netsky as the only package launcher", async () => {
    const root = await Bun.file(path.resolve(import.meta.dir, "../../../../package.json")).json()
    const cli = await Bun.file(path.resolve(import.meta.dir, "../../package.json")).json()

    expect(root).toMatchObject({
      name: "netsky-code",
      version: "0.1.0",
      description: "Netsky Code AI development agent",
    })
    expect(cli.bin).toEqual({ netsky: "./bin/netsky" })
  })

  test("netsky launcher forwards arguments to the selected native executable", async () => {
    await using dir = await tmpdir()
    const native = path.join(dir.path, "native-netsky")
    const launcher = path.resolve(import.meta.dir, "../../bin/netsky")
    await Bun.write(native, '#!/bin/sh\nprintf "Netsky Code %s\\n" "$*"\n')
    await Bun.$`chmod +x ${native}`

    const result = Bun.spawnSync([process.execPath, launcher, "--version"], {
      env: { ...process.env, OPENCODE_BIN_PATH: native },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toBe("Netsky Code --version\n")
  })

  test("release builds resolve the compatibility plugin independently of the public version", async () => {
    const distribution = await import("../../src/distribution").catch(() => undefined)
    expect(distribution).toBeDefined()
    expect(distribution?.compatibilityPluginVersion({ local: false })).toBe("1.18.25")
    expect(distribution?.compatibilityPluginVersion({ local: false })).not.toBe("0.1.0")
    expect(distribution?.compatibilityPluginVersion({ local: true })).toBeUndefined()
  })

  test("release target selection produces only the four supported Netsky archives", async () => {
    const targets = await import("../../script/build-targets").catch(() => undefined)
    expect(targets).toBeDefined()
    expect(
      targets?.selectBuildTargets({
        releaseTargets: true,
        single: false,
        baseline: false,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toEqual([
      { os: "linux", arch: "arm64" },
      { os: "linux", arch: "x64" },
      { os: "darwin", arch: "arm64" },
      { os: "darwin", arch: "x64" },
    ])
    expect(targets?.buildTargetName({ os: "linux", arch: "x64" })).toBe("netsky-linux-x64")
  })

  test("recognizes only Netsky-managed executable paths as curl installations", async () => {
    const distribution = await import("../../src/distribution")
    const method = (
      distribution as typeof distribution & {
        installationMethod?: (executable: string) => "curl" | "unknown"
      }
    ).installationMethod
    expect(method).toBeFunction()
    if (!method) return
    expect(method("/Users/test/.netsky/bin/netsky")).toBe("curl")
    expect(method("/Users/test/.local/bin/netsky")).toBe("unknown")
    expect(method("/Users/test/.opencode/bin/opencode")).toBe("unknown")
    expect(method("/opt/homebrew/bin/netsky")).toBe("unknown")
  })
})
