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
