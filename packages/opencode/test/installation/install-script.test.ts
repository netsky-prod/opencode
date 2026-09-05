import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

describe("fork install script", () => {
  const installer = path.resolve(import.meta.dir, "../../../../install")

  test("installs a supplied Netsky binary without replacing the legacy OpenCode binary", async () => {
    await using dir = await tmpdir()
    const binary = path.join(dir.path, "fixture-netsky")
    const legacy = path.join(dir.path, ".opencode/bin/opencode")
    await Bun.write(binary, "#!/bin/sh\necho Netsky Code 0.1.0\n")
    await Bun.write(legacy, "legacy-opencode\n")
    await $`chmod +x ${binary}`
    await $`HOME=${dir.path} bash ${installer} --binary ${binary} --no-modify-path`

    const installed = path.join(dir.path, ".netsky/bin/netsky")
    expect(await Bun.file(installed).exists()).toBe(true)
    expect((await $`${installed} --version`.text()).trim()).toBe("Netsky Code 0.1.0")
    expect(await Bun.file(legacy).text()).toBe("legacy-opencode\n")
  })

  test("downloads the Netsky archive from the fork and preserves existing OpenCode data", async () => {
    await using dir = await tmpdir()
    const fixture = path.join(dir.path, "fixture")
    const tools = path.join(dir.path, "tools")
    const archive = path.join(dir.path, "netsky-linux-arm64.tar.gz")
    const checksums = path.join(dir.path, "SHA256SUMS")
    const curlLog = path.join(dir.path, "curl.log")
    const tempLog = path.join(dir.path, "temp.log")
    const privateTmp = path.join(dir.path, "private-tmp")
    const legacyData = path.join(dir.path, ".local/share/opencode/session.json")

    await Bun.write(path.join(fixture, "netsky"), "#!/bin/sh\necho 0.1.0\n")
    await Bun.write(path.join(fixture, "LICENSE"), "MIT License\n\nNetsky Code distribution fixture\n")
    await Bun.write(legacyData, '{"session":"preserved"}\n')
    await $`mkdir -p ${privateTmp}`
    await $`chmod +x ${path.join(fixture, "netsky")}`
    await $`tar -czf ${archive} netsky LICENSE`.cwd(fixture)
    const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex")
    await Bun.write(checksums, `${digest}  netsky-linux-arm64.tar.gz\n`)

    await Bun.write(
      path.join(tools, "uname"),
      '#!/bin/sh\nif [ "${1:-}" = "-s" ]; then echo Linux; else echo aarch64; fi\n',
    )
    await Bun.write(
      path.join(tools, "curl"),
      `#!/bin/sh
url=""
output=""
previous=""
for argument in "$@"; do
  case "$argument" in https://*) url="$argument" ;; esac
  if [ "$previous" = "-o" ]; then output="$argument"; fi
  previous="$argument"
done
printf '%s\\n' "$url" >> "$NETSKY_TEST_CURL_LOG"
case " $* " in *" -w "*) printf 200; exit 0 ;; esac
case "$url" in
  */releases/latest) printf '{"tag_name":"v0.1.0"}' ;;
  */SHA256SUMS) cp "$NETSKY_TEST_CHECKSUMS" "$output" ;;
  *)
    cp "$NETSKY_TEST_ARCHIVE" "$output"
    download_dir=$(dirname "$output")
    mode=$(stat -f '%Lp' "$download_dir" 2>/dev/null || stat -c '%a' "$download_dir")
    printf '%s|%s\\n' "$download_dir" "$mode" > "$NETSKY_TEST_TEMP_LOG"
    : > "$download_dir/download.trace"
    ;;
esac
`,
    )
    await $`chmod +x ${path.join(tools, "uname")} ${path.join(tools, "curl")}`

    const result = Bun.spawnSync(["bash", installer, "--no-modify-path"], {
      env: {
        ...process.env,
        HOME: dir.path,
        PATH: `${tools}:${process.env.PATH}`,
        TMPDIR: privateTmp,
        NETSKY_TEST_ARCHIVE: archive,
        NETSKY_TEST_CHECKSUMS: checksums,
        NETSKY_TEST_CURL_LOG: curlLog,
        NETSKY_TEST_TEMP_LOG: tempLog,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const installed = path.join(dir.path, ".netsky/bin/netsky")
    expect((await $`${installed} --version`.text()).trim()).toBe("0.1.0")
    expect(await Bun.file(legacyData).text()).toBe('{"session":"preserved"}\n')
    expect(await Bun.file(path.join(dir.path, ".netsky/LICENSE")).text()).toContain("MIT License")
    const [downloadDir, mode] = (await Bun.file(tempLog).text()).trim().split("|")
    expect(path.basename(downloadDir)).toMatch(/^netsky-install\.[A-Za-z0-9]+$/)
    expect(mode).toBe("700")
    expect(Array.from(new Bun.Glob("netsky-install.*").scanSync({ cwd: privateTmp }))).toEqual([])
    expect(await Bun.file(curlLog).text()).toContain(
      "https://api.github.com/repos/netsky-prod/netsky-code/releases/latest",
    )
    expect(await Bun.file(curlLog).text()).not.toContain("/releases?per_page=1")
    expect(await Bun.file(curlLog).text()).toContain(
      "https://github.com/netsky-prod/netsky-code/releases/download/v0.1.0/netsky-linux-arm64.tar.gz",
    )
    expect(await Bun.file(curlLog).text()).toContain(
      "https://github.com/netsky-prod/netsky-code/releases/download/v0.1.0/SHA256SUMS",
    )
  })

  test.each([
    ["mismatched", `${"0".repeat(64)}  netsky-linux-arm64.tar.gz\n`],
    ["missing", `${"0".repeat(64)}  netsky-darwin-arm64.zip\n`],
  ])("rejects a %s release checksum without replacing the installed binary", async (_kind, manifest) => {
    await using dir = await tmpdir()
    const fixture = path.join(dir.path, "fixture")
    const tools = path.join(dir.path, "tools")
    const archive = path.join(dir.path, "netsky-linux-arm64.tar.gz")
    const checksums = path.join(dir.path, "SHA256SUMS")
    const installed = path.join(dir.path, ".netsky/bin/netsky")
    const privateTmp = path.join(dir.path, "private-tmp")

    await Bun.write(path.join(fixture, "netsky"), "#!/bin/sh\necho replacement\n")
    await Bun.write(installed, "#!/bin/sh\necho existing\n")
    await $`mkdir -p ${privateTmp}`
    await $`chmod +x ${path.join(fixture, "netsky")} ${installed}`
    await $`tar -czf ${archive} netsky`.cwd(fixture)
    await Bun.write(checksums, manifest)

    await Bun.write(
      path.join(tools, "uname"),
      '#!/bin/sh\nif [ "${1:-}" = "-s" ]; then echo Linux; else echo aarch64; fi\n',
    )
    await Bun.write(
      path.join(tools, "curl"),
      `#!/bin/sh
url=""
output=""
previous=""
for argument in "$@"; do
  case "$argument" in https://*) url="$argument" ;; esac
  if [ "$previous" = "-o" ]; then output="$argument"; fi
  previous="$argument"
done
printf '%s\\n' "$url" >> "$NETSKY_TEST_CURL_LOG"
case " $* " in *" -w "*) printf 200; exit 0 ;; esac
case "$url" in
  */SHA256SUMS) cp "$NETSKY_TEST_CHECKSUMS" "$output" ;;
  *) cp "$NETSKY_TEST_ARCHIVE" "$output" ;;
esac
`,
    )
    await $`chmod +x ${path.join(tools, "uname")} ${path.join(tools, "curl")}`

    const result = Bun.spawnSync(["bash", installer, "--no-modify-path"], {
      env: {
        ...process.env,
        HOME: dir.path,
        PATH: `${tools}:${process.env.PATH}`,
        TMPDIR: privateTmp,
        VERSION: "0.2.0-rc.1",
        NETSKY_TEST_ARCHIVE: archive,
        NETSKY_TEST_CHECKSUMS: checksums,
        NETSKY_TEST_CURL_LOG: path.join(dir.path, "curl.log"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).not.toBe(0)
    expect(`${result.stdout.toString()}${result.stderr.toString()}`).toContain("Checksum verification failed")
    expect((await $`${installed}`.text()).trim()).toBe("existing")
    expect(Array.from(new Bun.Glob("netsky-install.*").scanSync({ cwd: privateTmp }))).toEqual([])
    expect(await Bun.file(path.join(dir.path, "curl.log")).text()).toContain(
      "https://github.com/netsky-prod/netsky-code/releases/download/v0.2.0-rc.1/netsky-linux-arm64.tar.gz",
    )
  })
})
