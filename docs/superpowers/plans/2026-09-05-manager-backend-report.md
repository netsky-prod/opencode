# Capability/MCP manager backend implementation report

Date: 2026-09-05. Worktree: `capability-release`; branch: `netsky-release`.

## Implemented

- Extracted the existing Core capability enable/disable/status operations into a typed service provided by the same layer as the four model tools. Human and model operations share durable session state, locks, runtime references, registrations, dependency checks and materialization hooks. No synthetic tool context, assistant message, provider call or transcript is created for human operations.
- Host session operations validate both the session directory and workspace against the route location. Inventory does not require a session. Missing-manifest durable activations remain visible and disableable.
- Human disable persists immediately but retains the current advertised registrations/runtime handles until the next materialization boundary. The next turn omits those schemas and releases stale holds using the existing hook. Configuration refresh similarly invalidates reference fingerprints for next materialization.
- Added MCP exposure (`always-on` / `pack-only`) to compatible V1/V2 schemas. Default remains always-on. Pack-only configured servers do not connect at startup or appear in the baseline tool catalog.
- Added manifest MCP references (`{ id, type: "mcp", mcp: "configured-name" }`) with validation prohibiting a copied command/environment alongside a reference. Existing inline manifests continue to work.
- Referenced pack-only runtimes preserve configured OAuth identity and original canonical MCP tool names and permission resources. Multiple packs referencing the same server expose one schema per canonical tool. Always-on references acquire no additional connection and advertise no duplicate tools; unavailable always-on references fail activation visibly.
- Added redacted global/project MCP inventory and JSONC-preserving local/remote edits. Omitted credentials remain stored; inventory returns environment/header names, only the executable component of commands, and origin-only remote URLs. Malformed manager request bodies also cannot echo secret input through the existing schema-error response/log middleware.
- Added reference-only attachment to new or existing global/project user packs, preserving existing profile restrictions, other profiles and runtime options. Both displayed MCP revision and target pack revision are checked before writes. Migrating always-on exposure requires explicit confirmation; existing always-on edits likewise warn because reconnection can affect current sessions.
- Save/check/attach runtime resolution reloads the canonical Config resolver, preserving deep-merged inherited headers/environment and custom/ancestor/organization/managed precedence. Writes still target the selected standard source document, not a flattened effective configuration.
- Checks use an isolated hidden temporary registration and the original OAuth identity. They release only their own connection, bound connection timeout to at most 15 seconds, and return safe connected/failed/needs-auth outcomes. Shadowed global selections are rejected for attachment/check rather than silently acting on the effective project entry.
- Per-file writes use revision checks, owner-only temporary files, fsync and rename; symlink path components are refused. Locks publish complete PID/token ownership metadata atomically, retain live-owner exclusivity, and recover a demonstrably exited process's lock. Attachment holds both locks and stages the pack before changing exposure, so an interrupted migration does not advertise duplicate schemas.

## API and generated client

The existing instance/workspace/authorization HTTP middleware applies to every route. Safe manager errors are HTTP 400 with a message. The generated V2 SDK exposes `client.capability`:

| Method | Route | Principal request |
| --- | --- | --- |
| `list` | `GET /capability` | optional `sessionID` |
| `enable` | `POST /capability/enable` | `sessionID`, `id`, optional `profiles` |
| `disable` | `POST /capability/disable` | `sessionID`, `id` |
| `saveMcp` | `POST /capability/mcp` | `name`, `scope`, `revision`, `config`, `exposure`, optional confirmation |
| `checkMcp` | `POST /capability/mcp/check` | `name`, optional selected `scope` |
| `attachMcp` | `POST /capability/mcp/attach` | `name`, optional `mcpScope`, required `mcpRevision`, target `scope`, `packID`, `profile`, target pack `revision`, optional description/confirmation |

SDK method parameters are flat and also accept the existing directory/workspace fields. Inventory returns `packs`, `mcps`, and `configRevisions`; entries carry their originating-file revision. Pack source is `builtin`, `global`, `project`, or `unavailable`. Scope is global/project independently from exposure. Existing auth endpoints remain the OAuth workflow.

Generated with `bun packages/sdk/js/script/build.ts`, not hand-edited. `packages/client`'s `bun run generate` also completed and required no changes because these routes belong to the legacy host API rather than Core's Protocol API.

## Verification and red/green evidence

Execution used Bun 1.3.14 and the provided Node 24.20.0 toolchain, from package directories.

- Core: `bun test test/capability test/tool-capability.test.ts test/plugin/capability.test.ts` — **83 pass, 0 fail, 307 assertions**, 9 files.
- Host: `bun test test/capability/runtime.test.ts test/capability/pack-smoke.test.ts test/capability/manager-store.test.ts test/server/httpapi-capability.test.ts test/server/httpapi-mcp.test.ts test/server/httpapi-schema-error-body.test.ts test/mcp` — **105 pass, 0 fail, 371 assertions**, 16 files, 29.18 seconds.
- After atomic lock-metadata publication was tightened, `bun test test/capability/manager-store.test.ts` — **8 pass, 0 fail, 31 assertions**.
- `bun typecheck` passed in `packages/core`, `packages/opencode`, and `packages/sdk/js` after final implementation and SDK generation.
- Both generators exited 0. `git diff --check` passed.
- Direct human enable/disable behavioral tests were introduced before shared-service implementation. The HTTP test exercises real sessions and confirms no messages are created, another session remains isolated, and a foreign route directory is rejected.
- Existing OAuth reference invocation was tested against a real stub remote MCP with previously stored bearer credentials. Removing the auth identity handoff produced the expected failing regression; restoring it passed.
- Reviewer regressions reproduced and passed after fixes: advertised snapshot became stale on disable; attachment silently accepted an outdated MCP revision; URL pathname exposed a sentinel credential; dead process lock permanently blocked edits; layered environment credential disappeared on manager reconnection. The last uses a real local MCP subprocess that exits unless its inherited credential is present, then exercises save, check and reference activation.
- A malformed headers payload initially echoed a sentinel secret in the schema error; the scoped sanitization regression now passes together with the five existing generic schema-error tests.
- One earlier combined run timed out in the HTTP test while other generation/testing tasks were active; an unchanged standalone rerun passed. No definitive root cause was established. The final integrated run above passed.

## Boundaries and limitations

- Editable/listed storage sources are standard global `config.json`, `opencode.json`, `opencode.jsonc` and project root / `.opencode` JSON/JSONC files. Their actual originating file and precedence are preserved. Organization/managed/custom-only/ancestor-only servers are not independently inventoried or editable here; effective runtime resolution nevertheless uses canonical Config, so inherited credentials are not flattened, copied into packs, or discarded.
- Attachment is atomic per file, not a cross-file crash transaction. Staging order preserves safe always-on behavior if a crash occurs between the pack and exposure writes. Incomplete/unknown legacy lock metadata fails closed rather than guessing ownership; PID reuse may require manual inspection.
- Edits synchronize the current location's MCP runtime; other already-running locations may need their normal reload. Explicit always-on confirmation communicates possible current-session impact.
- No installer/build/identity/release/publish or real global user configuration operations were performed by this backend task. Native UI, real-provider acceptance, packaging and publication remain root-owned integration steps.

The approved executing-plans/TDD workflow shaped the shared-state extraction and regression-first fixes; verification-before-completion was used for the final test/typecheck/generator evidence. Reviewer feedback was checked against the existing registry/config lifecycle before implementation.
