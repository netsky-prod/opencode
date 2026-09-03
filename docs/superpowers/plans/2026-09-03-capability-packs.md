# Capability Packs and Epistemic Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship session-scoped capability packs, durable epistemic loop checkpoints, seven built-in packs, and a repeatable Qwen evaluation/distribution workflow in the `netsky-prod/opencode` fork.

**Architecture:** Core owns typed manifests, discovery, activation persistence, session-aware tool/skill filtering, runtime health, and loop checkpoints. OpenCode supplies an MCP runtime adapter and legacy-session integration while built-in packs compose existing MCP, CLI, skill, permission, and artifact primitives instead of inventing parallel systems. Only four capability-management schemas are always visible; all pack tools and skills are materialized from the requesting Session ID.

**Tech Stack:** TypeScript, Bun, Effect, Effect Schema, Drizzle/SQLite, OpenCode Core V2, legacy OpenCode runtime, MCP, Bun test.

**Spec:** `docs/superpowers/specs/2026-09-03-capability-packs-design.md`

## Global Constraints

- Preserve the existing durable loop as the only long-running task abstraction; do not add `goal_*` tools or a goal table.
- Capability activation is Session-scoped; compatible runtime processes may be Location-scoped and reference-counted.
- The default tool surface adds exactly `capability_search`, `capability_enable`, `capability_disable`, and `capability_status`.
- Inactive pack tool schemas and skills must not be materialized for a session.
- Existing permissions remain authoritative for every pack-owned tool execution.
- Built-in manifests pin exact runtime versions; manifest validation rejects unknown fields and canonical-name collisions.
- Support macOS and Linux and return actionable `healthy`, `degraded`, `failed`, or `unsupported` diagnostics.
- Use test-first red-green cycles and run tests/typecheck only from package directories.
- Never resolve credentials into model-visible manifests, status output, logs, or evaluation artifacts.
- After each runnable slice, launch the built fork against the configured RunPod Qwen endpoint in a dedicated tmux session, execute a real outcome-based task, save the transcript/tool trace, and independently verify the artifact or external state; unit tests alone do not close a slice.

---

### Task 1: Typed Capability Manifest and Catalog

**Files:**
- Create: `packages/core/src/capability/manifest.ts`
- Create: `packages/core/src/capability/catalog.ts`
- Create: `packages/core/test/capability/manifest.test.ts`
- Create: `packages/core/test/capability/catalog.test.ts`

**Interfaces:**
- Consumes: `ConfigMCP.Server`, `AbsolutePath`, `Location.Service`.
- Produces: `CapabilityManifest.Manifest`, `CapabilityManifest.Profile`, `CapabilityCatalog.Service`, `CapabilityCatalog.search(query, active)`.

- [ ] **Step 1: Write failing manifest tests**

```ts
test("decodes a pinned browser manifest and rejects unknown fields", () => {
  expect(decode(browserFixture).id).toBe("browser")
  expect(() => decode({ ...browserFixture, typo: true })).toThrow()
})

test("rejects invalid IDs, missing profiles, duplicate runtime IDs, and tool-name collisions", () => {
  for (const fixture of invalidFixtures) expect(() => decode(fixture)).toThrow()
})
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `bun test test/capability/manifest.test.ts` from `packages/core`.
Expected: FAIL because `CapabilityManifest` does not exist.

- [ ] **Step 3: Implement strict schemas and semantic validation**

```ts
export const Skill = Schema.Struct({
  name: ID,
  description: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
})
export const Runtime = Schema.Struct({
  id: ID,
  type: Schema.Literal("mcp", "cli"),
  command: Schema.Array(Schema.NonEmptyString),
  environment: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  optional: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  timeoutMs: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.positive()), { default: () => 15_000 }),
})
export const Profile = Schema.Struct({
  description: Schema.NonEmptyString,
  skills: Schema.Array(ID),
  runtimes: Schema.Array(ID),
})
export const Manifest = Schema.Struct({
  id: ID,
  version: Schema.Literal(1),
  description: Schema.NonEmptyString,
  platforms: Schema.Array(Schema.Literal("darwin", "linux")),
  skills: Schema.Array(Skill),
  runtimes: Schema.Array(Runtime),
  profiles: Schema.Record({ key: ID, value: Profile }),
  permissions: Schema.optional(Permissions),
})
```

Decode with `Schema.decodeUnknownEffect`, then validate all profile references, unique runtime IDs, relative contained skill paths, and deterministic canonical names `${pack}_${runtime}_${upstream}`.

- [ ] **Step 4: Write failing catalog precedence and ranking tests**

```ts
test("project manifests replace global manifests which replace built-ins", async () => {
  expect((await catalog.list()).find((pack) => pack.id === "research")?.source).toBe("project")
})

test("ranks IDs, descriptions, profiles, runtimes, dependencies, and skill summaries deterministically", async () => {
  expect((await catalog.search("inspect browser console"))[0]?.id).toBe("browser")
})
```

- [ ] **Step 5: Implement catalog discovery**

Discover built-ins plus `${XDG_CONFIG_HOME:-~/.config}/opencode/capabilities/*/capability.json` and `.opencode/capabilities/*/capability.json`; apply built-in/global/project precedence and stable fuzzy token scoring. Load skill files relative to the manifest and reject path escape. Keep the returned catalog immutable and sorted by ID.

- [ ] **Step 6: Verify and commit**

Run from `packages/core`: `bun test test/capability/manifest.test.ts test/capability/catalog.test.ts && bun typecheck`.

```bash
git add packages/core/src/capability packages/core/test/capability
git commit -m "feat(core): add capability manifest catalog"
```

---

### Task 2: Session Capability Persistence

**Files:**
- Modify: `packages/core/src/session/sql.ts`
- Create: `packages/core/src/capability/state.ts`
- Create: `packages/core/test/capability/state.test.ts`
- Create: generated migration under `packages/core/src/database/migration/`
- Modify: `packages/core/src/database/migration.gen.ts`

**Interfaces:**
- Consumes: `CapabilityCatalog.Service`, `Database.Service`, `SessionSchema.ID`.
- Produces: `SessionCapabilityTable`, `CapabilityState.Service.list(sessionID)`, `.enable(input)`, `.disable(input)`, `.status(sessionID)`.

- [ ] **Step 1: Write failing persistence tests**

```ts
test("activation survives a service restart and is isolated by session", async () => {
  await state.enable({ sessionID: first, id: "browser", profiles: ["default"] })
  expect(await reopened.list(first)).toEqual([{ id: "browser", profiles: ["default"], state: "active" }])
  expect(await reopened.list(second)).toEqual([])
})

test("deleting a session cascades its capability rows", async () => {
  await deleteSession(first)
  expect(await state.list(first)).toEqual([])
})
```

- [ ] **Step 2: Confirm RED**

Run from `packages/core`: `bun test test/capability/state.test.ts`.
Expected: FAIL because the table and service do not exist.

- [ ] **Step 3: Add the table and generate the migration**

```ts
export const SessionCapabilityTable = sqliteTable(
  "session_capability",
  {
    session_id: text().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    capability_id: text().notNull(),
    profiles_json: text().notNull(),
    state: text({ enum: ["active", "degraded"] }).notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.capability_id] })],
)
```

Run from `packages/core`: `bun script/migration.ts --name session_capability` and `bun script/migration.ts --check`.

- [ ] **Step 4: Implement atomic state operations**

Serialize mutations per `(sessionID, capabilityID)`. Validate the pack and requested profiles before upsert. Store sorted unique profiles as JSON, retain missing-manifest activations so status can report `unavailable`, and never substitute another manifest.

- [ ] **Step 5: Verify and commit**

Run from `packages/core`: `bun test test/capability/state.test.ts test/database-migration.test.ts && bun typecheck`.

```bash
git add packages/core/src/session/sql.ts packages/core/src/capability/state.ts packages/core/src/database packages/core/test
git commit -m "feat(core): persist session capabilities"
```

---

### Task 3: Shared Runtime Manager and MCP Adapter Contract

**Files:**
- Create: `packages/core/src/capability/runtime.ts`
- Create: `packages/core/test/capability/runtime.test.ts`
- Modify: `packages/opencode/src/mcp/index.ts`
- Create: `packages/opencode/src/capability/runtime.ts`
- Create: `packages/opencode/test/capability/runtime.test.ts`
- Modify: `packages/opencode/src/effect/app-runtime.ts`

**Interfaces:**
- Consumes: validated manifest runtime definitions and existing OpenCode MCP lifecycle.
- Produces: `CapabilityRuntime.Service.acquire(key, definition)`, `.release(key)`, `.status(key)`, and OpenCode `MCP.definitions(name)` returning immutable upstream tool definitions plus settlement closures.

- [ ] **Step 1: Write failing Core lifecycle tests**

```ts
test("deduplicates concurrent acquisition and stops after the final idle release", async () => {
  const [a, b] = await Promise.all([runtime.acquire(key, definition), runtime.acquire(key, definition)])
  expect(starts).toBe(1)
  await runtime.release(a)
  expect(stops).toBe(0)
  await runtime.release(b)
  await clock.adjust("31 seconds")
  expect(stops).toBe(1)
})

test("rolls back a failed required runtime and reports optional failures as degraded", async () => {
  expect(await activate(requiredFailure)).toMatchObject({ state: "failed" })
  expect(await activate(optionalFailure)).toMatchObject({ state: "degraded" })
})
```

- [ ] **Step 2: Confirm RED, then implement runtime state machine**

Run from `packages/core`: `bun test test/capability/runtime.test.ts`.

Implement `stopped | starting | healthy | degraded | failed`, deduplicated acquisition, reference tokens, 30-second idle close, bounded startup timeout, one bounded restart after crash, and redacted diagnostics. Activation acquires all required resources before persistence and releases all partial acquisitions on failure.

- [ ] **Step 3: Write failing OpenCode MCP adapter tests**

```ts
test("starts a manifest-owned MCP and exposes stable definitions without global config", async () => {
  const handle = await adapter.acquire(browserServer)
  expect(handle.tools.map((tool) => tool.name)).toContain("browser_playwright_navigate")
})

test("does not expose resolved environment values in status", async () => {
  expect(JSON.stringify(await adapter.status(key))).not.toContain(secret)
})
```

- [ ] **Step 4: Add a narrow MCP adapter**

Extend the existing MCP service with a definition API instead of copying its transport implementation:

```ts
readonly definitions: (name: string) => Effect.Effect<ReadonlyArray<{
  readonly upstreamName: string
  readonly description: string
  readonly inputSchema: JSONSchema7
  readonly call: (input: unknown) => Effect.Effect<CallToolResult, MCPError>
}>>
```

The capability adapter owns manifest-started server config, connects through the existing MCP service, canonicalizes names, and unregisters on final release. Existing user-configured MCP servers remain always-on.

- [ ] **Step 5: Verify and commit**

Run from `packages/core`: `bun test test/capability/runtime.test.ts && bun typecheck`.
Run from `packages/opencode`: `bun test test/capability/runtime.test.ts && bun typecheck`.

```bash
git add packages/core/src/capability packages/core/test/capability packages/opencode/src/mcp packages/opencode/src/capability packages/opencode/src/effect packages/opencode/test/capability
git commit -m "feat(opencode): manage capability runtimes"
```

---

### Task 4: Session-Aware Tool and Skill Materialization

**Files:**
- Modify: `packages/core/src/tool/tool.ts`
- Modify: `packages/core/src/tool/tools.ts`
- Modify: `packages/core/src/tool/registry.ts`
- Modify: `packages/core/src/session/runner/llm.ts`
- Modify: `packages/core/src/skill/guidance.ts`
- Modify: `packages/core/src/tool/skill.ts`
- Create: `packages/core/test/capability/materialization.test.ts`

**Interfaces:**
- Consumes: `CapabilityState.Service.list(sessionID)` and registrations tagged with `Tool.Origin`.
- Produces: `Tool.withOrigin(tool, origin)`, `ToolRegistry.materialize(sessionID, permissions)`, and session-filtered skill guidance/loading.

- [ ] **Step 1: Write failing two-session materialization tests**

```ts
test("only the enabling session receives pack tools", async () => {
  await state.enable({ sessionID: first, id: "browser", profiles: ["default"] })
  expect(names(await registry.materialize(first))).toContain("browser_playwright_navigate")
  expect(names(await registry.materialize(second))).not.toContain("browser_playwright_navigate")
})

test("a captured materialization settles in-flight calls but rejects stale replacements", async () => {
  const advertised = await registry.materialize(first)
  await state.disable({ sessionID: first, id: "browser" })
  expect(await advertised.settle(call)).toMatchObject({ result: { type: "text" } })
  expect(names(await registry.materialize(first))).not.toContain(call.name)
})
```

- [ ] **Step 2: Confirm RED and implement origins/filtering**

Run from `packages/core`: `bun test test/capability/materialization.test.ts`.

```ts
export type Origin =
  | { readonly type: "builtin" }
  | { readonly type: "plugin"; readonly pluginID: string; readonly capability?: string; readonly profile?: string }
  | { readonly type: "mcp"; readonly serverID: string; readonly capability?: string; readonly profile?: string }

export const withOrigin = <I extends SchemaType<unknown>, O extends SchemaType<unknown>>(
  tool: Definition<I, O>,
  origin: Origin,
) => Definition<I, O>
```

Change `materialize` to require `sessionID`; retain an immutable registration identity per provider turn; filter tagged definitions by active pack/profile before permission filtering. Pass `session.id` at the runner call site.

- [ ] **Step 3: Add failing skill isolation tests, then implement**

```ts
test("pack skills are absent before enable, visible after enable, and hidden after disable", async () => {
  expect(await visible(second)).not.toContain("browser-testing")
  await state.enable({ sessionID: second, id: "browser", profiles: ["default"] })
  expect(await visible(second)).toContain("browser-testing")
  await state.disable({ sessionID: second, id: "browser" })
  expect(await visible(second)).not.toContain("browser-testing")
})
```

Change guidance and skill-tool lookup to accept Session ID and filter only capability-owned skills; untagged skills preserve current behavior. A skill already present in history is not removed retroactively.

- [ ] **Step 4: Verify and commit**

Run from `packages/core`: `bun test test/capability/materialization.test.ts test/skill/guidance.test.ts test/tool/skill.test.ts && bun typecheck`.

```bash
git add packages/core/src/tool packages/core/src/skill packages/core/src/session/runner/llm.ts packages/core/test
git commit -m "feat(core): scope capabilities to sessions"
```

---

### Task 5: Capability Management Tools and System Guidance

**Files:**
- Create: `packages/core/src/tool/capability.ts`
- Create: `packages/core/test/tool-capability.test.ts`
- Modify: `packages/core/src/system-context/builtins.ts`
- Modify: `packages/core/test/system-context/builtins.test.ts`
- Modify: `packages/core/src/location-services.ts`

**Interfaces:**
- Consumes: catalog, state, runtime, and tool registration services.
- Produces: exactly four always-on management tools and the short routing instruction from the spec.

- [ ] **Step 1: Write failing contract tests**

```ts
test("advertises exactly four capability management tools by default", async () => {
  expect(names(await registry.materialize(sessionID)).filter((name) => name.startsWith("capability_"))).toEqual([
    "capability_disable", "capability_enable", "capability_search", "capability_status",
  ])
})

test("enable is atomic and returns tools available on the next materialization", async () => {
  expect(await call("capability_enable", { id: "browser", profiles: ["default"] })).toMatchObject({
    state: "active", nextTurn: true,
  })
})
```

- [ ] **Step 2: Confirm RED and implement the four tools**

Run from `packages/core`: `bun test test/tool-capability.test.ts`.

Use bounded structured schemas. Search returns at most ten ranked summaries. Enable validates platform/profiles, probes dependencies, acquires required runtime resources, commits activation last, and reports exact next-turn tools/skills. Disable hides future definitions immediately and releases references. Status reports installed, active, degraded, failed, unsupported, health timestamps, and remediation without secrets or raw logs.

- [ ] **Step 3: Add and test routing guidance**

Append exactly:

```text
When the current tools cannot observe or complete the requested outcome, search the installed capability packs and autonomously enable the smallest sufficient set. Disable temporary packs when they are no longer useful.
```

- [ ] **Step 4: Verify and commit**

Run from `packages/core`: `bun test test/tool-capability.test.ts test/system-context/builtins.test.ts && bun typecheck`.

```bash
git add packages/core/src/tool/capability.ts packages/core/src/system-context packages/core/src/location-services.ts packages/core/test
git commit -m "feat(core): add capability management tools"
```

---

### Task 6: Browser and Research Built-In Packs

**Files:**
- Create: `packages/core/src/plugin/capability.ts`
- Create: `packages/core/src/plugin/capability/browser/capability.json`
- Create: `packages/core/src/plugin/capability/browser/browser-testing.md`
- Create: `packages/core/src/plugin/capability/research/capability.json`
- Create: `packages/core/src/plugin/capability/research/research.md`
- Modify: `packages/core/src/plugin/internal.ts`
- Create: `packages/core/test/plugin/capability.test.ts`
- Create: `packages/opencode/test/capability/e2e.test.ts`

**Interfaces:**
- Consumes: catalog embedded-source registration and OpenCode MCP adapter.
- Produces: `browser/default`, `browser/diagnostics`, and `research/default` built-in packs.

- [ ] **Step 1: Write failing built-in manifest tests**

```ts
test("ships pinned browser and research profiles", async () => {
  expect(await catalog.get("browser")).toMatchObject({ profiles: { default: {}, diagnostics: {} } })
  expect(await catalog.get("research")).toMatchObject({ profiles: { default: {} } })
  expect(allCommands(await catalog.list()).every(isExactlyPinned)).toBe(true)
})
```

- [ ] **Step 2: Confirm RED and add manifests/skills**

Run from `packages/core`: `bun test test/plugin/capability.test.ts`.

Pin browser runtime commands to `@playwright/mcp@0.0.80` and `chrome-devtools-mcp@1.8.0`. Research references the configured Federated Research MCP endpoint, Context7, and the existing `webfetch`; environment values remain `${NAME}` references. Skills require primary-source fetch, citation capture, artifact evidence, and outcome verification.

- [ ] **Step 3: Write and pass end-to-end isolation tests**

Serve a local fixture, enable `browser/default`, navigate, inspect, and save a screenshot artifact. In a second Session ID verify no browser schemas. Enable research against a deterministic fixture MCP, retrieve a known primary source, fetch it, and preserve citation metadata. Disable both and advance the test clock past idle shutdown.

Run from `packages/opencode`: `bun test test/capability/e2e.test.ts`.

- [ ] **Step 4: Verify and commit**

Run from `packages/core`: `bun test test/plugin/capability.test.ts && bun typecheck`.
Run from `packages/opencode`: `bun test test/capability/e2e.test.ts && bun typecheck`.

```bash
git add packages/core/src/plugin packages/core/test/plugin packages/opencode/test/capability
git commit -m "feat(core): ship browser and research packs"
```

- [ ] **Step 5: Run the first live Qwen gate in tmux**

Build the worktree OpenCode, start a named tmux session `capability-slice-1`, and point it at the already configured RunPod Qwen endpoint without printing its bearer token. Give Qwen two fresh tasks: repair and verify a seeded bug in the local browser fixture using `browser/default`, and answer a source-sensitive technical question using `research/default`. Capture the OpenCode transcript and tool trace under `.superpowers/sdd/2026-09-03-capability-packs/live/slice-1/`. Independently assert the repaired fixture behavior, screenshot artifact, cited primary-source URL, session isolation, smallest-profile selection, and absence of inactive schemas.

---

### Task 7: Durable Loop Checkpoint Schema and Tools

**Files:**
- Modify: `packages/core/src/session/sql.ts`
- Modify: `packages/core/src/session/loop.ts`
- Modify: `packages/core/src/tool/loop.ts`
- Modify: `packages/core/test/session-loop.test.ts`
- Modify: `packages/core/test/tool-loop.test.ts`
- Create: generated migration under `packages/core/src/database/migration/`
- Modify: `packages/core/src/database/migration.gen.ts`

**Interfaces:**
- Consumes: existing `SessionLoop` CRUD and loop tool family.
- Produces: bounded `LoopCheckpoint`, initial checkpoint on create, partial update via `loop_checkpoint`, summaries in list, and verified completion state.

- [ ] **Step 1: Write failing checkpoint schema tests**

```ts
test("normalizes duplicate strings and persists evidence across restart", async () => {
  await loops.checkpoint(id, { objective: "Ship", observations: ["seen", "seen"], nextAction: "test" })
  expect((await reopened.get(id)).checkpoint?.observations).toEqual(["seen"])
})

test("rejects oversized fields and completion with unverified acceptance criteria", async () => {
  expect(loops.checkpoint(id, oversized)).rejects.toThrow("checkpoint")
  expect(loops.checkpoint(id, { state: "completed" })).rejects.toThrow("acceptance")
})
```

- [ ] **Step 2: Confirm RED and add schema/migration**

Run from `packages/core`: `bun test test/session-loop.test.ts`.

Add nullable `checkpoint_json`. Implement the exact checkpoint shape from the spec with 4,000 characters per string, 50 items per array, 100 evidence URLs total, unique normalized strings, and 128 KiB encoded maximum. Invalid stored JSON returns a typed loop diagnostic and is omitted from scheduler prompts.

Run from `packages/core`: `bun script/migration.ts --name loop_checkpoint && bun script/migration.ts --check`.

- [ ] **Step 3: Write failing tool tests and implement partial merge**

```ts
test("loop_checkpoint merges supplied fields and keeps omitted fields", async () => {
  await tool({ loopID, observations: ["new"], nextAction: "verify" })
  expect((await loops.get(loopID)).checkpoint).toMatchObject({ objective: "Ship", observations: ["new"], nextAction: "verify" })
})
```

Add optional initial checkpoint input to `loop_create`, checkpoint patch to `loop_update`, a focused `loop_checkpoint`, and bounded checkpoint summaries to `loop_list`. Adaptive completion requires a reason, all acceptance criteria represented by verified facts with evidence, and a final checkpoint update. Fixed maintenance loops retain optional checkpoints.

- [ ] **Step 4: Verify and commit**

Run from `packages/core`: `bun test test/session-loop.test.ts test/tool-loop.test.ts test/database-migration.test.ts && bun typecheck`.

```bash
git add packages/core/src/session packages/core/src/tool/loop.ts packages/core/src/database packages/core/test
git commit -m "feat(core): persist loop checkpoints"
```

---

### Task 8: Checkpoint Wake Injection and Compaction Context

**Files:**
- Modify: `packages/core/src/session/loop-scheduler.ts`
- Create: `packages/core/src/session/loop-context.ts`
- Modify: `packages/core/src/session/runner/llm.ts`
- Modify: `packages/core/src/location-services.ts`
- Modify: `packages/core/test/session-loop-scheduler.test.ts`
- Create: `packages/core/test/session-loop-context.test.ts`

**Interfaces:**
- Consumes: `SessionLoop` checkpoint storage and System Context composition.
- Produces: scheduled wake prompt rendering and bounded active-loop context keyed by Session ID.

- [ ] **Step 1: Write failing wake and restart tests**

```ts
test("wake prompt includes identity, reason, checkpoint, prompt, and update instruction", async () => {
  expect(await wakePrompt(loop)).toContain("Verified facts")
  expect(await wakePrompt(loop)).toContain("Update the checkpoint before")
})

test("restart reloads the durable checkpoint before the next scheduled admission", async () => {
  expect(await restartedWake(loopID)).toContain("next action: run smoke test")
})
```

- [ ] **Step 2: Confirm RED and implement wake rendering**

Run from `packages/core`: `bun test test/session-loop-scheduler.test.ts`.

Render structured sections in the spec order. Treat checkpoint content as fallible evidence, not system truth. Corrupt JSON yields a diagnostic and does not stop other loops.

- [ ] **Step 3: Write failing compaction-context tests and implement**

```ts
test("active loop context survives compaction and omits completed loops", async () => {
  const text = await context.load(sessionID)
  expect(text).toContain("objective: Ship")
  expect(text).toContain("next action: Test")
  expect(text).not.toContain("completed-loop")
})
```

Create a Session-ID keyed context source capped at 8 KiB that renders active loops, includes paused loops only when explicitly referenced by the current turn, includes artifact paths, and never duplicates full checkpoint JSON. Load it for every provider turn so the first post-compaction turn retains objective/evidence/next action.

- [ ] **Step 4: Verify and commit**

Run from `packages/core`: `bun test test/session-loop-scheduler.test.ts test/session-loop-context.test.ts && bun typecheck`.

```bash
git add packages/core/src/session packages/core/src/location-services.ts packages/core/test
git commit -m "feat(core): inject loop checkpoint context"
```

- [ ] **Step 5: Run the checkpoint live Qwen gate in tmux**

Start `capability-slice-2`, ask Qwen to create an adaptive loop that waits on a changing local fixture, force a process restart and a context compaction boundary, then change the fixture so the acceptance criterion becomes true. Preserve the transcript under `.superpowers/sdd/2026-09-03-capability-packs/live/slice-2/` and independently verify that objective, evidence, uncertainty, artifact, and next action survive; that completion occurs only after evidence; and that no `goal_*` object is created.

---

### Task 9: Mobile, Security, Documents, GitHub, and Deploy Packs

**Files:**
- Create: pack directories under `packages/core/src/plugin/capability/{mobile,security,documents,github,deploy}/`
- Modify: `packages/core/src/plugin/capability.ts`
- Modify: `packages/core/test/plugin/capability.test.ts`
- Create: `packages/opencode/test/capability/pack-smoke.test.ts`

**Interfaces:**
- Consumes: built-in source/catalog, CLI and MCP runtime probes, existing permissions, tool-output artifacts.
- Produces: five built-in manifests, routing skills, health/remediation status, and normalized artifacts.

- [ ] **Step 1: Write failing manifest/platform tests**

```ts
test("all shipped packs decode and every profile references real runtimes and skills", async () => {
  expect((await catalog.list()).map((pack) => pack.id)).toEqual([
    "browser", "deploy", "documents", "github", "mobile", "research", "security",
  ])
})

test("mobile reports iOS unsupported on Linux and missing Android tools as degraded", async () => {
  expect(await status("mobile", linux)).toMatchObject({ profiles: { ios: { state: "unsupported" } } })
})
```

- [ ] **Step 2: Confirm RED and add manifests/skills**

Run from `packages/core`: `bun test test/plugin/capability.test.ts`.

Create these exact profiles and probes:

```text
mobile/ios: xcodebuild -version, xcrun simctl list -j, flutter --version
mobile/android: adb version, flutter --version
security/static: semgrep --version, codeql version, gitleaks version, osv-scanner --version, trivy --version
security/dynamic: zap.sh -version, nuclei -version, schemathesis --version, nmap --version, mitmproxy --version, k6 version
documents/default: markitdown --version, pdftotext -v, tesseract --version, ffmpeg -version, ffprobe -version
github/default: gh --version and gh auth status
deploy/core: docker version and docker compose version
deploy/runpod: runpodctl version
deploy/cloudflare: wrangler --version
```

Mark optional dependencies individually so one missing executable degrades only the relevant profile. Skills write large output to the existing session artifact store. Security/dynamic and deploy operations use canonical existing permission actions and never embed credentials.

- [ ] **Step 3: Add deterministic smoke fixtures**

Use disposable local fixtures and stub executables on `PATH` to test probe parsing, artifact normalization, and permission evaluation. Test real platform tools only behind explicit environment flags; unavailable host tools must produce deterministic `degraded` or `unsupported`, not skipped assertions.

- [ ] **Step 4: Verify and commit**

Run from `packages/core`: `bun test test/plugin/capability.test.ts && bun typecheck`.
Run from `packages/opencode`: `bun test test/capability/pack-smoke.test.ts && bun typecheck`.

```bash
git add packages/core/src/plugin/capability packages/core/test/plugin packages/opencode/test/capability
git commit -m "feat(core): ship operational capability packs"
```

- [ ] **Step 5: Run operational-pack live Qwen gates in tmux**

Use one named tmux session per pack (`capability-mobile`, `capability-security`, `capability-documents`, `capability-github`, `capability-deploy`). Give Qwen disposable real tasks whose results can be checked without trusting its prose: inspect an available simulator or return actionable degradation; detect seeded security findings; extract facts from representative documents; inspect a fixture GitHub repository read-only; and build/health-check a disposable Docker service. Save transcripts/tool traces under `.superpowers/sdd/2026-09-03-capability-packs/live/slice-3/` and independently check artifacts, permissions, selected profiles, and cleanup.

---

### Task 10: Observability and Context Instrumentation

**Files:**
- Create: `packages/core/src/capability/event.ts`
- Modify: capability state/runtime/catalog/materialization modules
- Create: `packages/core/test/capability/event.test.ts`
- Create: `packages/core/src/capability/token-estimate.ts`
- Create: `packages/core/test/capability/token-estimate.test.ts`

**Interfaces:**
- Consumes: existing observability/event infrastructure and materialized JSON schemas.
- Produces: redacted lifecycle events, startup latency, and deterministic schema token estimates.

- [ ] **Step 1: Write failing event/redaction tests**

```ts
test("emits lifecycle and materialization events without secrets", async () => {
  const events = await exercise({ token: "never-log-me" })
  expect(events.map((event) => event.type)).toContain("capability.activated")
  expect(JSON.stringify(events)).not.toContain("never-log-me")
})
```

- [ ] **Step 2: Confirm RED and implement typed events**

Run from `packages/core`: `bun test test/capability/event.test.ts`.

Emit requested/succeeded/degraded/failed activation, runtime started/reused/stopped/crashed, definitions added/removed, checkpoint updated/completion requested, startup latency, and schema estimate. Allow IDs, state, duration, counts, and diagnostic references only; exclude arguments, headers, environment values, and browser storage.

- [ ] **Step 3: Implement deterministic schema estimates test-first**

Estimate context as UTF-8 serialized schema bytes and a documented `ceil(bytes / 4)` token approximation. Record baseline versus activated totals without introducing a tokenizer runtime dependency.

- [ ] **Step 4: Verify and commit**

Run from `packages/core`: `bun test test/capability/event.test.ts test/capability/token-estimate.test.ts && bun typecheck`.

```bash
git add packages/core/src/capability packages/core/test/capability
git commit -m "feat(core): observe capability lifecycle"
```

---

### Task 11: Versioned Qwen Evaluation Suite

**Files:**
- Create: `packages/opencode/eval/capability/README.md`
- Create: `packages/opencode/eval/capability/cases.json`
- Create: `packages/opencode/eval/capability/run.ts`
- Create: `packages/opencode/eval/capability/score.ts`
- Create: `packages/opencode/test/capability/eval.test.ts`
- Modify: `packages/opencode/package.json`

**Interfaces:**
- Consumes: an OpenAI-compatible Qwen endpoint, test workspace fixtures, capability events, and artifact evidence.
- Produces: `bun run eval:capability`, versioned cases, JSON/Markdown comparison reports, and pass/fail thresholds.

- [ ] **Step 1: Write failing scorer tests**

```ts
test("scores verified outcomes rather than self-reported completion", () => {
  expect(score(caseDefinition, selfClaimOnly)).toMatchObject({ completed: false })
  expect(score(caseDefinition, verifiedArtifacts)).toMatchObject({ completed: true })
})

test("penalizes unnecessary activation and incorrect tool calls", () => {
  expect(score(caseDefinition, noisyRun).incorrectToolCalls).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Confirm RED and implement scorer/runner**

Run from `packages/opencode`: `bun test test/capability/eval.test.ts`.

Cases cover missing-capability recognition; smallest profile selection; browser, research, mobile, security, document, GitHub, and deploy outcomes; checkpoint evidence; no unnecessary activation; and recovery from missing dependencies. Runner executes baseline and capability modes with identical model/sampling/context settings and records task completion, verified criteria, wrong calls, provider tokens, time-to-first-useful-action, and wall time.

- [ ] **Step 3: Add reproducibility controls**

Redact keys and hostnames, persist model ID/quantization/server commit/OpenCode commit/case version, support `--dry-run`, `--baseline`, `--candidate`, and `--output`, and fail only when candidate verified completion does not exceed baseline or default capability schemas exceed the four-tool budget.

- [ ] **Step 4: Verify and commit**

Run from `packages/opencode`: `bun test test/capability/eval.test.ts && bun run eval:capability --dry-run && bun typecheck`.

```bash
git add packages/opencode/eval packages/opencode/test/capability/eval.test.ts packages/opencode/package.json
git commit -m "test(opencode): add capability qwen evals"
```

---

### Task 12: Authoring Docs, Installer, Migration, and Release Verification

**Files:**
- Create: `docs/capabilities.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-03-capability-packs-design.md`
- Modify: existing fork install/release documentation and scripts discovered by `rg -n "install|upgrade|release" docs script packages/opencode`
- Create: `packages/opencode/test/capability/distribution.test.ts`

**Interfaces:**
- Consumes: all prior public interfaces.
- Produces: installable fork docs, pack authoring reference, migration instructions, and final acceptance evidence.

- [ ] **Step 1: Write failing distribution tests**

```ts
test("release payload contains every built-in manifest and skill", async () => {
  expect(await packagedCapabilityIDs()).toEqual([
    "browser", "deploy", "documents", "github", "mobile", "research", "security",
  ])
})

test("a fresh config has only four capability management schemas", async () => {
  expect(await freshCapabilityTools()).toEqual([
    "capability_disable", "capability_enable", "capability_search", "capability_status",
  ])
})
```

- [ ] **Step 2: Confirm RED and update packaging**

Run from `packages/opencode`: `bun test test/capability/distribution.test.ts`.

Ensure JSON/Markdown assets are bundled for source, compiled binary, and fork installer paths. Document manifest schema, precedence, profiles, session semantics, runtime sharing, environment references, permission behavior, status remediation, platform support, and migration of globally configured research MCPs into `research/default`.

- [ ] **Step 3: Run full acceptance verification**

From `packages/core`:

```bash
bun test
bun typecheck
bun script/migration.ts --check
```

From `packages/opencode`:

```bash
bun test
bun typecheck
bun run build
bun run eval:capability --dry-run
```

Confirm the ten acceptance criteria in the spec against test names and captured output. Run platform status on the local Mac and record only states/remediation, never environment values.

Run a final `capability-final` tmux session against RunPod Qwen with an unseen multi-capability task requiring research, browser verification, durable checkpointing, and artifact production. Save the redacted transcript/tool trace under `.superpowers/sdd/2026-09-03-capability-packs/live/final/`; verify every artifact externally and compare the run to the baseline scorer before declaring completion.

- [ ] **Step 4: Commit and prepare integration**

```bash
git add README.md docs packages/opencode
git commit -m "docs: document capability packs"
git status --short
git log --oneline origin/dev..HEAD
```

Do not merge, push, publish, or alter the user's global OpenCode configuration as part of this task; those are explicit post-verification integration actions.
