# Fork installation and releases

This fork ships unsigned OpenCode CLI binaries for macOS arm64/x64 and glibc Linux arm64/x64. It does not publish npm, Homebrew, Scoop, Chocolatey, desktop, Windows, musl, or non-AVX2 x64 builds. Those package-manager installations remain upstream OpenCode.

## Install or upgrade

```bash
curl -fsSL https://raw.githubusercontent.com/netsky-prod/opencode/dev/install | bash
opencode --version
```

The installer writes `~/.opencode/bin/opencode`. A curl-installed fork checks only `netsky-prod/opencode` for updates and replaces that same binary.

The binaries are unsigned. On macOS, approve the binary explicitly in System Settings → Privacy & Security when Gatekeeper blocks it. Alternatively, after verifying that the downloaded file came from this repository's release, remove quarantine from that exact binary:

```bash
xattr -d com.apple.quarantine ~/.opencode/bin/opencode
```

## Build the current branch

The installer downloads published release assets, not the latest `dev` source. To test unpublished capability changes, clone this fork, install the Bun version from `package.json`, then run:

```bash
bun install --frozen-lockfile
cd packages/opencode
OPENCODE_CHANNEL=local bun run build --single --skip-install
./dist/opencode-darwin-arm64/bin/opencode --version
```

Choose the matching `dist/opencode-<os>-<arch>` directory on other hosts. The normal build embeds the Web UI; `--skip-embed-web-ui` is suitable only for a CLI-only development build. Preserve your previous installed binary before copying a tested build over it. Configuration and databases are not part of the archive and must not be overwritten during installation.

The `local` channel avoids requesting an unpublished fork-version plugin package from npm. Use an explicit version/channel only for a release whose plugin dependency strategy has been verified.

Built-in capability JSON/Markdown is embedded by Bun's static imports. Do not add installation steps that copy these assets from a developer checkout. External pack dependencies (browsers, Node/npm/npx, Xcode, Flutter, scanners, GitHub CLI, Docker) are not embedded. See [capability setup and migration](./capabilities.md).

Before a capability release, run `bun test test/capability/distribution.test.ts test/capability/e2e.test.ts` and a real-model acceptance run, in addition to the normal package tests and typechecks. The SDK generator's required-body patch is a committed Bun dependency patch and must survive `bun install --frozen-lockfile`.

## Sync upstream

Add the upstream remote once:

```bash
git remote add upstream https://github.com/anomalyco/opencode.git
```

Then merge upstream into the fork branch and resolve any conflicts before testing:

```bash
git fetch upstream
git switch dev
git merge upstream/dev
git push origin dev
```

`git merge --ff-only upstream/dev` may be used only while the fork's `dev` has no fork-only commits.

## Publish a prerelease

Run the manual workflow with an explicit `X.Y.Z-loop.N` version:

```bash
gh workflow run fork-release.yml -f version=1.18.25-loop.1
gh run watch
gh release view v1.18.25-loop.1
```

The workflow first creates a draft prerelease, builds with the existing Bun build script, uploads the four required archives, verifies their names, and only then publishes the release. It deliberately does not use upstream's private runners, signing credentials, npm publishing, or desktop release jobs.

Before publishing, run the focused installation tests and a native build from `packages/opencode` as described in the implementation plan. For loop behavior and syntax, see [Durable loops](./loop.md).
