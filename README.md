<p align="center"><img src="docs/assets/netsky-code.svg" width="520" alt="Netsky Code"></p>

<p align="center">An open-source agent harness for building, researching, and getting work done.</p>
<p align="center"><a href="README.ru.md">Русский</a> · <a href="https://github.com/netsky-prod/opencode/releases">Releases</a> · <a href="docs/capabilities.md">Capabilities</a> · <a href="docs/loop.md">Loops</a></p>

Netsky Code is an independently maintained harness built on [OpenCode](https://github.com/anomalyco/opencode). It keeps the terminal-first workflow, model choice, tools, skills, and MCP ecosystem, and adds session-scoped capability packs and durable continuation.

**Your model. Your runtime. Your tools.** Use a local endpoint, your own GPU server, or a supported hosted provider. The harness does not include model weights or a hosted inference subscription.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/netsky-prod/opencode/dev/install | bash
netsky --version
netsky
```

Release **0.1.0** ships unsigned CLI binaries for macOS (Apple Silicon and Intel) and glibc Linux (arm64 and AVX2-capable x64). The CLI also includes a web interface, launched with `netsky web`. There is no Netsky npm/Homebrew package or signed desktop release yet; installing `opencode-ai` installs upstream OpenCode.

See [installation, verification, and upgrades](docs/fork-release.md). On macOS, an unsigned binary can require explicit approval in Privacy & Security.

## What is different

- **Capability packs:** load tools and guidance when a session needs them. Inactive packs stay out of the model's tool context.
- **A human-facing manager:** `/capabilities` manages packs and MCP connections directly. Add local or remote MCPs, choose project/global storage, and attach them to a pack.
- **Separate scope and activation:** “stored globally” does not mean “always loaded.” Pack activations belong to a conversation.
- **Durable loops:** `/loop` schedules another turn in the same session, with fixed or agent-selected wake-up times, pause/resume, and persisted state.
- **Evidence checkpoints:** retain acceptance criteria, verified facts, uncertainty, blockers, artifacts, and next actions across continuation.
- **Model and tool compatibility:** retain OpenCode-compatible providers, plugins, skills, permissions, and MCP tooling.

Included packs cover browser automation, research, mobile development, security assessment tooling, documents/media, GitHub, and deployment. Packs may need separately installed programs or configured services. “Enabled” is not proof that a task succeeded; the manager reports dependencies and health.

LangGraph Swarm, peer-swarm coordination, and Hugging Face Agent Collabs are **not in 0.1.0**. They are planned as optional future flows.

## First session

```sh
cd your-project
netsky
```

Connect a model provider through `/connect` or use your existing compatible configuration. Open `/capabilities` to inspect available packs and connections. Ask for a concrete outcome and how you want it verified.

```text
/capabilities
/loop 10m check the test run and continue with the next verified fix
/loop list
```

The scheduler needs a running Netsky Code process. Closing every process pauses it until the harness starts again.

## Migrating from our OpenCode fork

Launch with `netsky` instead of `opencode`. Existing OpenCode-compatible configuration and data paths remain supported in 0.1.0, including `~/.config/opencode`, project `.opencode` directories, and existing session storage. This is intentional compatibility, not a second empty profile.

Existing MCPs remain configured; moving one into pack-only activation is an explicit operation in the manager. Keep credentials in their existing config/secret source, not in shareable pack manifests. Internal `@opencode-ai/*` packages and `OPENCODE_*` variables retain their names for compatibility.

## Build from source

```sh
git clone https://github.com/netsky-prod/opencode.git netsky-code
cd netsky-code
bun install --frozen-lockfile
cd packages/opencode
OPENCODE_CHANNEL=local bun run build --single --skip-install
./dist/netsky-darwin-arm64/bin/netsky --version
```

Use the Bun version declared in [package.json](package.json) and the matching platform directory. The normal native build embeds the web interface.

## Documentation and contributing

- [Capabilities and MCP management](docs/capabilities.md)
- [Durable loops](docs/loop.md)
- [Installation and release runbook](docs/fork-release.md)
- [Contributing](CONTRIBUTING.md)
- [Report an issue](https://github.com/netsky-prod/opencode/issues)

English and Russian are the maintained Netsky README versions. The other README entry points link here rather than advertising unrelated upstream releases.

## License and attribution

[MIT](LICENSE). Netsky Code incorporates OpenCode and preserves its original copyright and license notices. It is independently maintained by netsky-prod and is not an official OpenCode release or affiliated with the OpenCode team. External providers, plugins, and tools retain their own names and licenses.
