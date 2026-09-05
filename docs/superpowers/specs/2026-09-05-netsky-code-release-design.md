# Netsky Code 0.1.0

Approved scope: finish the capability manager, rebrand the distributed harness as Netsky Code, launch with `netsky`, update documentation, install locally, and publish the first Netsky Code release. LangGraph Swarm, peer swarm, and Agent Collabs are explicitly excluded.

## Capability manager

Expose one native TUI manager through `/capabilities`; preserve `/mcps` as a discoverable entry. Humans act directly through authenticated server APIs, without generating a model prompt or fake transcript. Reuse the existing catalog, session activations, runtime ownership, permissions, and health checks.

The manager lists packs, profiles, active state and actionable diagnostics. Activations affect the selected session and become effective at the next provider-turn boundary. It also lists configured MCP servers and offers a guided local-command or remote-URL editor, credentials/header/environment input, connection checking, and global/project persistence.

Allow attaching existing MCP definitions to a new or existing user pack by reference. Never copy resolved secrets into manifests. Global storage and always-on exposure are independent: existing global MCPs remain working until the user explicitly chooses pack-only exposure. The manager must warn before changing a connection used globally; avoid duplicate tools after migration. Preserve unrelated configuration and JSONC comments, use atomic writes, reject conflicting writes and malformed names, and never leak secrets in lists, errors, logs, or model context. Authentication and original tool permission enforcement remain intact.

## Identity and compatibility

Public product name is `Netsky Code`; the executable and all new installation, launch, and update instructions use `netsky`. Release version is `0.1.0`. Preserve upstream MIT license/copyright and clearly acknowledge the OpenCode foundation. Do not claim the fork was written from scratch.

Keep existing `opencode` internal package namespaces, protocol names, config/database paths, and environment variables compatible in this first release unless a tested additive alias is supplied. Existing sessions, configured Qwen endpoints, skills, MCPs, and credentials must keep working. Remove upstream branding from primary shipped TUI/web entry points and launch/help/update surfaces without renaming unrelated vendor identifiers or rewriting historical evidence.

Distribute unsigned native macOS arm64/x64 and glibc Linux arm64/x64 archives with checksums and a stable release manifest. Do not imply signed desktop apps, npm publication, Windows or mobile binaries are included. The public GitHub repository rename is pending the user's separate asynchronous choice; no upstream repository is ever a publication target.

## Verification and release

Use existing isolated worktree `.worktrees/capability-release` on branch `netsky-release`. Do not touch user running sessions or unrelated dirty files. Test session isolation, restart persistence, missing dependencies, local/remote MCP setup and invocation, secret redaction, and safe config mutation. Run native TUI interactions and a real Qwen task through the new executable. Preserve the previous binary before installation.

Run focused tests, affected package typechecks, broader regressions, a native build and packaged install/upgrade tests. Generate clients from declared API schemas. Publish a draft first; make it public only when all four archives/checksums and verification evidence are complete. Push to the user's fork explicitly, never gh's inferred upstream default.
