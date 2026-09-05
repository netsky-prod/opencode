# Netsky Code distribution report

## Implemented

- Public product metadata identifies Netsky Code `0.1.0`; the package launcher, native executable, build directories, and archives use `netsky` / `netsky-<platform>`.
- `--release-targets` selects only macOS arm64/x64 and glibc Linux arm64/x64. It excludes Windows, musl, and baseline artifacts from the release workflow.
- The installer writes `~/.netsky/bin/netsky`, leaves `~/.opencode/bin/opencode` and existing OpenCode config/data/history untouched, and sources releases only from `netsky-prod/opencode`.
- Downloaded release archives are verified against the same release's `SHA256SUMS` before extraction. Missing or mismatched entries fail closed without replacing an installed binary. Explicit `--binary` installs remain trusted local input.
- Automatic/manual upgrades use only the fork installer. Legacy npm, Bun, pnpm, Homebrew, Scoop, and Chocolatey methods cannot fetch upstream releases or packages.
- Release builds pin `@opencode-ai/plugin` compatibility to the internal `packages/opencode` version (`1.18.25`) instead of the public Netsky version (`0.1.0`); local builds preserve the existing unpinned workspace behavior.
- CLI startup, help, upgrade/uninstall copy, direct-mode prompts, and shared TUI wordmarks show Netsky Code and `netsky`. Internal `@opencode-ai/*`, `OPENCODE_*`, protocol/provider identifiers, and persistence paths remain unchanged.

## Verification

- `bash -n install`
- `bun test test/installation test/cli/help/help-snapshots.test.ts test/cli/error.test.ts test/cli/run/permission.shared.test.ts --timeout 180000`: 32 pass, 0 fail, 34 snapshots.
- `bun typecheck` in `packages/opencode`: pass.
- `bun typecheck` in `packages/tui`: temporarily blocked by concurrent Task 3 work (`test/component/dialog-capabilities.test.ts` imports missing `validateMcpName`); the logo change itself previously typechecked before that test appeared.
- Native build: `OPENCODE_VERSION=0.1.0 OPENCODE_CHANNEL=latest bun run script/build.ts --single --skip-install --skip-embed-web-ui`.
- Native probes: `dist/netsky-darwin-arm64/bin/netsky` is a Mach-O arm64 executable; `--version` prints `0.1.0`; `--help` shows `Netsky Code` and `netsky [command]`.

## Remaining integration gaps

- The native build deliberately used `--skip-embed-web-ui`; combined acceptance must build once with the already-rebranded embedded web UI.
- The repository constant remains `netsky-prod/opencode` until the pending repository rename decision is resolved.
- ACP agent metadata and model system prompts still contain upstream identity in files outside this distribution ownership. They should be reviewed separately before claiming an exhaustive product-wide rebrand.
- No global install, publication, push, or release mutation was performed by this task.
