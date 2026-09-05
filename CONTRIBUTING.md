# Contributing to Netsky Code

Netsky Code is independently maintained by netsky-prod and based on OpenCode. Changes belong in this repository, not automatically in the upstream issue tracker.

Bug fixes, reliable tool integrations, capability packs, model compatibility, performance work, and clear documentation are welcome. Discuss changes to orchestration or public interfaces before implementing a large feature.

## Development

Use Bun 1.3.14 and read [AGENTS.md](AGENTS.md).

```sh
bun install --frozen-lockfile
bun dev .
```

The source directory and internal package namespaces retain their OpenCode names for compatibility. The distributed executable is `netsky`.

- `packages/core`: session, tools, capability state/runtime and foundational services.
- `packages/opencode`: CLI, host adapters, HTTP server and integration tests.
- `packages/tui`: Solid/OpenTUI terminal interface.
- `packages/app`: embedded web interface.
- `packages/plugin`, `packages/sdk`, `packages/client`: compatibility and generated client surfaces.

## Verify changes

Run tests and typechecks from the affected package directory, not repository root:

```sh
cd packages/opencode
bun test test/capability
bun typecheck
```

Add regression tests for observable behavior. UI changes should include native/browser evidence. Model-facing changes need a real-model task as well as deterministic tests; record which model and what was actually verified.

After changing public HTTP API schemas, run the applicable generators; never edit generated clients by hand. See AGENTS.md for the generation commands and dependency boundaries.

## Build

```sh
OPENCODE_CHANNEL=local bun packages/opencode/script/build.ts --single --skip-install
./packages/opencode/dist/netsky-darwin-arm64/bin/netsky --version
```

Select the directory matching your platform. Read the [release runbook](docs/fork-release.md) before changing installation or upgrade behavior.

## Pull requests

Keep changes focused. State the problem, the approach, and the verification performed. Use conventional commit/PR titles such as `fix(capability): preserve session isolation`. Do not include API keys, model credentials, private endpoints, captured personal conversations or unrelated generated artifacts.

Preserve the MIT license and original copyright notices. Describe upstream compatibility honestly. Swarm and Agent Collabs are future work, not features shipped in 0.1.0.
