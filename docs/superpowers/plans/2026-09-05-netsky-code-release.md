# Netsky Code 0.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a usable, verified Netsky Code 0.1.0 with a direct capability/MCP manager and the `netsky` executable.

**Architecture:** Extend the existing capability runtime and configuration ownership, expose typed HTTP management APIs, and consume them in the native TUI. Rebrand public distribution surfaces while keeping data and package compatibility. Backend and distribution changes have separate file ownership and can be implemented independently.

**Tech Stack:** Bun 1.3.14, TypeScript, Effect, Solid/OpenTUI, generated OpenCode SDK, GitHub Releases.

**Spec:** `docs/superpowers/specs/2026-09-05-netsky-code-release-design.md`

## Global Constraints

- Product `Netsky Code`; command `netsky`; release `0.1.0`.
- Exclude LangGraph Swarm, peer swarm, and Agent Collabs.
- Keep upstream MIT attribution and existing config/database/package compatibility.
- Do not publish to inferred upstream: explicitly use the user's repository.
- No npm/desktop/Windows/mobile publication; macOS arm64/x64 and glibc Linux arm64/x64 unsigned CLI assets.
- Tests run from package directories with Bun; source edits use apply_patch; generated clients use their generators.

## Task 1: Direct capability and MCP management backend

Files: `packages/core/src/tool/capability.ts`, `packages/core/src/capability/manifest.ts`, `packages/opencode/src/capability/`, host HTTP group/handler assembly, and capability tests. Backend worker owns generated SDK updates after declaring contracts.

Consumes: existing catalog/state/runtime and Config/MCP services. Produces: typed manager list, activation/deactivation, MCP save/check, and pack attachment endpoints. Send exact SDK method names/payloads to TUI integrator before UI implementation.

- [x] Add failing integration tests for direct session-scoped enable/disable, no fabricated conversation, and different-session isolation.
- [x] Extract/reuse shared management operations; human entry points must not ask the LLM to perform toggles.
- [x] Add failing tests for local/remote MCP persistence and reference-based pack attachment; assert unrelated JSONC config and secrets are preserved and never exposed in diagnostics.
- [x] Implement atomic configuration/manifest operations and explicit always-on vs pack-only selection.
- [x] Run capability integration suites and affected typechecks; generate SDKs; commit only owned files after green verification.

Example behavioral boundary for tests:

```ts
expect((await list(sessionA)).packs.find((p) => p.id === "browser")?.active).toBe(true)
expect((await list(sessionB)).packs.find((p) => p.id === "browser")?.active).toBe(false)
expect(serializedPublicStatus).not.toContain("test-only-bearer-secret")
```

## Task 2: Public identity and executable distribution

Files: `install`, `packages/opencode/script/build.ts`, CLI entry/help/installation/uninstall, public TUI logo identity (coordinate app.tsx edits), installation tests, root package metadata. Do not rename internal `@opencode-ai/*` packages or existing persistence paths.

Consumes: existing fork installer/build flow. Produces: native `netsky` executable/assets and fork-only install/upgrade behavior.

- [x] Add failing installer/upgrade tests exercising Netsky archive names and the `netsky` executable, preserving old data.
- [x] Implement Netsky public constants, startup/help/logo text and binary packaging; keep upstream compatibility identifiers internal.
- [x] Verify installed binary probes, installer error paths, release URL selection and plugin resolution without an unpublished npm version.
- [x] Run focused installation tests and typechecks; commit only owned files.

```sh
netsky --version
netsky --help
netsky -c
```

## Task 3: Native manager UI

Files: `packages/tui/src/component/dialog-capabilities.tsx`, supporting focused dialogs/tests, `packages/tui/src/app.tsx`, and existing MCP dialog entry.

Consumes: Task 1 generated SDK management methods; existing DialogSelect/DialogPrompt, route sessionID, toast and SDK contexts. Produces: `/capabilities` and `/mcps` direct UI flow.

- [x] Add failing UI/model tests for status rendering, profile choice, missing session, pending actions, errors, and form payloads.
- [x] Add pack list/detail/enable/disable, configured MCP list/edit/add/check, and attach/create-pack dialogs. Require a session only for session activation, not inventory or global configuration.
- [x] Keep secrets masked; display scope and exposure separately; do not optimistically report failed writes as success.
- [x] Run TUI tests/typecheck and native PTY acceptance through keyboard navigation with controlled real MCP fixtures.

## Task 4: Documentation, web identity, release packaging

Files: root README languages, `docs/capabilities.md`, `docs/fork-release.md`, `docs/loop.md`, relevant shipped web identity/assets and `.github/workflows/fork-release.yml`.

- [x] Replace upstream-facing installation/marketing README content with honest Netsky positioning, commands, supported platforms, current features and upstream attribution. Link translations to maintained English/Russian docs when full translations are not maintained.
- [x] Document migration and capability menu; list deferred features as not shipped.
- [x] Update fork release workflow to accept stable semver, build four archives, generate/verify checksums, and publish only after validation.
- [x] Verify README links and install instructions against produced artifacts; preserve licensing.

## Task 5: Acceptance and publication

- [ ] Review combined diffs and run package typechecks and broad regression suites; record known unrelated failures precisely rather than silently waiving them.
- [ ] Build native release and test `netsky --version`, help, restored config/history, `/capabilities`, local/remote MCP call and real Qwen task.
- [ ] Back up current installed binary and install verified `netsky` with reachable PATH.
- [ ] Commit, push the user fork, trigger release workflow, and wait for artifacts/checksums before stable publication.
- [ ] Download published host archive through the documented installer in an isolated prefix; verify version and checksum.
- [ ] Report release URL, install command, compatibility notes and actual verification results.
