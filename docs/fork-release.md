# Netsky Code installation and releases

Netsky Code ships unsigned CLI binaries for macOS arm64/x64 and glibc Linux arm64/x64 (AVX2 required on Linux x64). The web UI is embedded. There are no Netsky npm, Homebrew, Scoop, Chocolatey, signed desktop, Windows, musl, or mobile releases in 0.1.0.

## Install or upgrade

```sh
curl -fsSL https://raw.githubusercontent.com/netsky-prod/opencode/dev/install | bash
netsky --version
netsky
```

The default executable is `~/.netsky/bin/netsky`. Open a new terminal if its PATH has not been refreshed. `netsky upgrade` checks the Netsky repository, not upstream OpenCode. Existing OpenCode-compatible configuration, credentials, project `.opencode` resources, and session storage remain in their original locations. The installer does not delete your previous `opencode` binary.

The binaries are unsigned. On macOS, approve the exact binary in System Settings → Privacy & Security if Gatekeeper blocks it. Do not disable Gatekeeper system-wide.

## Verify a release manually

Download the platform archive plus `SHA256SUMS` from the same [release](https://github.com/netsky-prod/opencode/releases). In the directory containing those downloads, verify the matching file:

```sh
# Example: Apple Silicon
shasum -a 256 netsky-darwin-arm64.zip
# Compare the result with the netsky-darwin-arm64.zip line in SHA256SUMS.
unzip netsky-darwin-arm64.zip
./netsky --version
```

`release.json` records the version, supported platform, archive size and hash. Checksums detect corruption or mismatched downloads; they are not a code signature or an independent publisher identity check.

## Build the branch

The installer downloads published release assets, not unpublished source. Use Bun 1.3.14, as pinned in package.json:

```sh
bun install --frozen-lockfile
cd packages/opencode
OPENCODE_CHANNEL=local bun run build --single --skip-install
./dist/netsky-darwin-arm64/bin/netsky --version
```

Choose `dist/netsky-<os>-<arch>` for your host. The normal build embeds the web UI. `--skip-embed-web-ui` is for CLI-only development probes, not the published release. Preserve a previous binary before replacing an existing installation.

Compatibility names such as `OPENCODE_CHANNEL`, internal `@opencode-ai/*` packages and persistence paths are retained deliberately. Built-in capability manifests and guidance are embedded; browsers, Node/npm/npx, Xcode, Flutter, scanners, GitHub CLI, Docker and remote services are separate prerequisites.

## Release verification

From `packages/opencode`:

```sh
bun test test/installation
bun test test/capability/distribution.test.ts test/capability/e2e.test.ts
bun typecheck
```

Also run affected Core/TUI/App tests and typechecks, a native keyboard-driven manager check, and a real-model task that invokes an enabled MCP tool. Check fresh-session isolation and restart persistence. The [capability documentation](capabilities.md) describes scope, permissions, and migration.

## Publish

Run against the Netsky repository explicitly: `gh` can otherwise infer the upstream repository for a fork.

```sh
gh workflow run fork-release.yml --repo netsky-prod/opencode --ref dev -f version=0.1.0
gh run list --repo netsky-prod/opencode --workflow fork-release.yml
gh run watch RUN_ID --repo netsky-prod/opencode
gh release view v0.1.0 --repo netsky-prod/opencode
```

The manual workflow creates a draft, builds only the four supported targets, packages them through `script/netsky-release.ts`, verifies checksums and the Linux executable, uploads all required files, checks the uploaded asset list, then publishes. Stable versions become stable releases; versions with a prerelease suffix remain prereleases. Do not reuse a published version.

## Sync the foundation

```sh
git remote add upstream https://github.com/anomalyco/opencode.git
git fetch upstream
git switch dev
git merge upstream/dev
```

Only add the remote if it is not already configured. Resolve conflicts, preserve Netsky identity and compatibility, and verify before pushing to your fork. This repository does not use upstream private signing or publishing infrastructure.
