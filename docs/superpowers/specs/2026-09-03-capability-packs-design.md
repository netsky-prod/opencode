# Capability Packs and Epistemic Loop Checkpoints

**Date:** 2026-09-03

**Status:** Proposed

**Target:** `netsky-prod/opencode` fork

## Summary

Extend OpenCode with session-scoped capability packs and durable epistemic checkpoints inside the existing loop system.

A capability pack groups the instructions, tools, MCP servers, runtime dependencies, health checks, and permission hints needed for one class of work. The agent sees only a compact capability discovery interface by default and may activate the packs required for the current task. Tool schemas from inactive packs are not sent to the model.

The existing durable loop remains the sole long-running task abstraction. It gains a structured checkpoint that preserves the shared objective, acceptance criteria, evidence, uncertainty, decisions, blockers, and next action. No separate goal entity or parallel goal lifecycle is introduced.

## Motivation

The current local agent already has strong baseline capabilities:

- filesystem inspection and editing;
- shell execution;
- Git, authenticated GitHub CLI, Docker, and Xcode;
- durable fixed and adaptive loops;
- federated web and scientific research;
- library documentation through Context7;
- Superpowers skills and a general-purpose chief-level system prompt.

The remaining failure mode is closure. The agent can produce code or analysis but often cannot observe the final product, interact with it, preserve task state across long executions, or select specialized tooling without permanently loading every tool schema into the model context.

## Goals

1. Let the agent discover and activate specialized capabilities without restarting OpenCode.
2. Keep inactive capability tool schemas out of the model context.
3. Scope tool visibility to a session so parallel sessions can use different packs.
4. Share expensive runtime processes at the workspace level when safe.
5. Preserve task epistemology inside durable loops without creating a separate goal abstraction.
6. Ship useful browser, research, mobile, security, document, GitHub, and deployment packs.
7. Make pack activation autonomous for reversible local actions while preserving the existing permission system for consequential tool execution.
8. Support macOS and Linux, with platform-specific health reporting where a capability is unavailable.
9. Measure whether the system improves task completion for the configured Qwen model rather than judging it only by tool availability.

## Non-goals

- Replacing OpenCode's plugin, skill, MCP, or permission systems.
- Creating a second marketplace format for packages that already exist.
- Creating a standalone `Goal` record, goal scheduler, or goal tool family.
- Automatically installing large system dependencies without an explicit installation command.
- Sending every installed tool definition to the model.
- Automatically inferring user intent with regular expressions or a hidden routing LLM.
- Treating a successful tool invocation as proof that the user's task is complete.

## Design principles

### Packs compose existing primitives

A pack is orchestration metadata over existing OpenCode primitives. It may reference:

- one or more skills;
- built-in or plugin tools;
- local or remote MCP servers;
- CLI programs invoked by skills through the shell;
- health checks and platform requirements;
- default permission hints.

The pack format does not reimplement those systems.

### Discovery stays small

Only four pack-management tools are always advertised:

- `capability_search`
- `capability_enable`
- `capability_disable`
- `capability_status`

The system context contains one short instruction telling the agent to search for a capability when the current tools cannot observe or complete the requested outcome. It does not contain every pack's full manifest.

### Activation is session-scoped

Pack activation belongs to a Session ID. A browser pack enabled in one session must not add Playwright schemas to unrelated sessions in the same project.

MCP clients and other expensive processes may be shared by compatible sessions in the same Location. Tool materialization filters their registered tools using the active pack set for the requesting session.

### Existing permissions remain authoritative

Enabling a pack is a reversible local operation. The agent may do it autonomously. Enabling does not grant permission to execute every tool in the pack. Each tool call continues through the existing permission resolver using its canonical action and resource.

### Evidence is explicit

Long-running work must distinguish verified facts, observations, inferences, and unresolved assumptions. A loop checkpoint preserves that distinction and is included in future scheduled turns.

## Architecture

```text
User task
   |
   v
SessionRunner
   |
   +--> Capability state for Session ID
   |       |
   |       +--> capability_search / enable / disable / status
   |       +--> active pack IDs and feature profiles
   |
   +--> ToolRegistry.materialize(sessionID, permissions)
   |       |
   |       +--> always-on built-ins
   |       +--> tools tagged with active pack IDs
   |       +--> existing permission filtering
   |
   +--> Provider turn with only materialized schemas

Workspace/Location runtime
   |
   +--> shared MCP clients and CLI runtime probes
   +--> reference counts from active sessions
   +--> idle shutdown and crash recovery

SessionLoop
   |
   +--> schedule, prompt, state, reason
   +--> epistemic checkpoint
   +--> scheduled wake injects prompt + checkpoint
```

## Capability manifests

### Discovery locations

Manifests are discovered with existing OpenCode precedence rules:

1. packs shipped with the fork;
2. global packs under `~/.config/opencode/capabilities/`;
3. project packs under `.opencode/capabilities/`.

Higher-precedence manifests may disable or replace a pack with the same ID. Pack IDs use lowercase ASCII segments separated by hyphens.

### Manifest shape

```yaml
id: browser
version: 1
description: Interact with and verify web applications in a real browser.
platforms: [darwin, linux]

skills:
  - browser-testing

tools:
  builtins: []
  mcp:
    - id: playwright
      command: [npx, -y, "@playwright/mcp@0.0.80"]
      profile: default
    - id: chrome-devtools
      command: [npx, -y, "chrome-devtools-mcp@1.8.0"]
      profile: diagnostics

dependencies:
  - id: node
    check: [node, --version]
  - id: chrome
    optional: true

healthcheck:
  timeout_ms: 15000

permissions:
  hints:
    - action: browser
      resource: "http://localhost:*"
```

The implementation uses an Effect Schema representation rather than parsing manifests into untyped objects. Unknown fields fail validation so misspelled configuration cannot silently disable safeguards or tools.

Shipped manifests pin exact package or image versions verified by the fork release. User-authored manifests may choose floating versions, but status reports them as unpinned.

### Profiles

A pack may expose profiles to avoid loading its entire tool family. For example:

- `browser/default`: Playwright interaction and screenshots;
- `browser/diagnostics`: Chrome console, network, and performance tracing;
- `security/static`: source, secret, and dependency analysis;
- `security/dynamic`: web and API probing.

`capability_enable` accepts a pack ID and optional profile names. Enabling another profile updates the session activation and takes effect on the next provider turn.

## Capability discovery and activation

### Search

`capability_search` accepts a natural-language description of the missing capability. It searches manifest IDs, descriptions, profiles, dependencies, and skill summaries. It returns a small ranked result with:

- pack ID and profiles;
- what it enables;
- dependency health;
- platform compatibility;
- whether it is already active.

There is no regex-based task classifier and no hidden model call. The agent explicitly decides when to search. The initial implementation uses deterministic full-text and fuzzy ranking over a small manifest catalog. The interface permits an optional embedding index later without changing model-facing tools.

### Enable

`capability_enable` performs these steps atomically from the session's perspective:

1. resolve the manifest and requested profiles;
2. validate platform compatibility;
3. run bounded dependency probes;
4. acquire or start shared runtimes;
5. wait for required MCP servers to report connected;
6. persist the session activation;
7. return the exact tools and skills that will become available on the next provider turn.

An activation is committed only after required components are healthy. Optional components are reported as degraded without failing the base pack.

### Disable

`capability_disable` removes the session activation immediately for future materializations. It does not interrupt a tool invocation already in flight. Existing ToolRegistry materializations already protect against unknown and stale calls; the capability filter preserves that behavior.

Shared runtimes are reference-counted. They stop after an idle grace period when no session uses the corresponding pack/profile.

### Status

`capability_status` reports installed, active, degraded, and failed packs. It includes health-check timestamps and concise remediation for missing dependencies without dumping process logs into model context.

## Tool registry changes

Tool registrations gain optional origin metadata:

```ts
type ToolOrigin =
  | { type: "builtin" }
  | { type: "plugin"; pluginID: string; capability?: string; profile?: string }
  | { type: "mcp"; serverID: string; capability?: string; profile?: string }
```

`ToolRegistry.materialize` receives the Session ID in addition to permissions. It asks `CapabilityState` for the active pack/profile set and removes tagged tools that are not active before producing provider definitions.

Settlement remains bound to the immutable materialization used for that provider turn. Enabling or disabling a pack during a turn affects only the next materialization.

Untagged built-in and user-configured tools preserve their current behavior. Existing MCP configuration remains supported; MCP servers not owned by a capability manifest continue to be always-on unless disabled by configuration.

Pack-owned skills follow the same session visibility rule. They are discoverable through `capability_search`, become available to the skill loader after activation, and disappear from future guidance after disable. A skill already loaded into conversation history is not retroactively removed.

Pack-owned MCP tools retain deterministic canonical names derived from pack, server, and upstream tool ID. A name collision fails manifest validation instead of shadowing an existing registration.

## Capability persistence

Capability activation is stored as session-owned data:

```text
session_capability
  session_id
  capability_id
  profiles_json
  state            active | degraded
  time_created
  time_updated
```

The table references the session with cascade deletion. It stores activation, not installed package definitions. Manifests remain filesystem configuration and are revalidated at startup/reload.

When an active manifest is removed or becomes invalid, materialization hides its tools and status reports the activation as unavailable. It does not silently substitute another pack.

## Loop epistemic checkpoints

### Ownership

Each loop owns its checkpoint because a session may have multiple independent loops. The checkpoint is added to the existing `session_loop` record rather than creating a goal table.

### Shape

```ts
type LoopCheckpoint = {
  objective: string
  acceptanceCriteria: string[]
  verifiedFacts: Array<{ claim: string; evidence?: string[] }>
  observations: string[]
  inferences: Array<{ claim: string; confidence: "low" | "medium" | "high" }>
  assumptions: string[]
  decisions: Array<{ decision: string; reason: string }>
  blockers: string[]
  artifacts: string[]
  nextAction: string
  updatedAt: number
}
```

The checkpoint is bounded in size. Individual text fields and arrays have limits, duplicate strings are normalized, and oversized updates fail rather than being silently truncated.

### Tools

The existing loop family gains:

- optional initial checkpoint fields on `loop_create`;
- `checkpoint` updates on `loop_update`;
- a focused `loop_checkpoint` tool for partial checkpoint updates;
- checkpoint summaries in `loop_list`;
- `state: completed` in `loop_checkpoint` when every acceptance criterion is verified.

No `goal_*` tools are added.

### Scheduled wake-up

The scheduler injects:

1. loop identity, mode, and reason;
2. the current structured checkpoint;
3. the loop prompt;
4. an instruction to update the checkpoint before scheduling, pausing, or completing the next wake-up.

The checkpoint is model-visible evidence, not trusted truth. The agent may correct it when new evidence conflicts with an earlier entry.

### Compaction and ordinary continuation

An active loop checkpoint is not limited to scheduled wake prompts. Session context loading gains a bounded loop-checkpoint source keyed by Session ID. It emits compact summaries for active loops before each provider turn, including the first turn after compaction. Completed loops are omitted, and paused loops are included only when the current turn explicitly refers to them.

The full structured checkpoint remains in durable storage; the context source renders a bounded summary with artifact references. This prevents compaction from erasing the shared objective or evidence without duplicating the complete checkpoint on every turn.

### Completion

Adaptive loops continue using `loop_wakeup`. Completion requires a reason and an updated checkpoint. The tool does not independently judge semantic success, but the wake prompt and system guidance require verified acceptance criteria before completion.

Fixed loops may remain recurring maintenance jobs without finite acceptance criteria. For those loops, checkpoint fields are optional and completion behavior is unchanged.

## Shipped capability packs

### Browser

Default profile:

- Playwright MCP for navigation, accessibility snapshots, interaction, and screenshots;
- a browser-testing skill that turns user outcomes into executable UI checks;
- isolated browser state by default;
- an opt-in persistent profile for user-authorized logged-in sessions.

Diagnostics profile:

- Chrome DevTools MCP for console, network, source-mapped errors, and performance traces.

The default profile is sufficient for normal product closure. Diagnostics stays inactive until needed.

### Research

- Federated Research MCP for broad web and scientific retrieval;
- Context7 for current library documentation;
- built-in `webfetch` for primary-source inspection;
- the existing research skill for source selection, verification, deduplication, and synthesis.

The current globally enabled research MCP entries migrate into this pack while preserving credentials through environment interpolation.

### Mobile

- Mobile MCP for iOS and Android interaction;
- Flutter, `xcodebuild`, `simctl`, and `adb` CLI guidance;
- simulator/device discovery, screenshots, interaction, crash reports, and recordings;
- explicit degraded status when Xcode simulators, Android SDK, or Flutter are missing.

iOS execution is available only on macOS. Android may run on macOS or Linux when its SDK is present.

### Security

Static profile:

- Semgrep and CodeQL for source analysis;
- Gitleaks for secret discovery;
- OSV-Scanner and Trivy for dependency, filesystem, image, and supply-chain findings.

Dynamic profile:

- OWASP ZAP and Nuclei for web assessment;
- Schemathesis for OpenAPI property-based testing;
- nmap and mitmproxy for network and protocol observation;
- k6 for load and degradation tests.

These tools are exposed through a focused security skill and shell commands instead of one MCP server per executable. Commands produce normalized artifacts under the session tool-output store. The existing permission system controls execution targets.

### Documents

- MarkItDown for PDF, Office, HTML, and structured-document conversion;
- `pdftotext` for fast text-first PDF extraction;
- Tesseract for OCR;
- ffmpeg/ffprobe for audio and video inspection;
- bounded extraction that stores large results as artifacts rather than placing entire documents in model context.

### GitHub

- authenticated `gh` CLI workflows for issues, pull requests, Actions, releases, and repository metadata;
- a concise skill that prefers `gh --json` and checks CI/release state;
- no GitHub MCP by default because its large schema duplicates the installed CLI and adds context overhead.

### Deploy

Core profile:

- Docker build, compose, logs, health checks, and image inspection.

Optional provider profiles:

- RunPod lifecycle and endpoint checks;
- Cloudflare Wrangler deployment and logs;
- extensible project-defined providers.

Credentials remain in the operating-system credential store or environment references. Manifests never contain resolved secrets.

## Skills and system guidance

Each pack includes one short routing skill. Detailed vendor documentation remains in references loaded only when needed.

The default agent system prompt gains one additional behavior:

> When the current tools cannot observe or complete the requested outcome, search the installed capability packs and autonomously enable the smallest sufficient set. Disable temporary packs when they are no longer useful.

This instruction complements the chief-level prompt without enumerating tools or vendors.

## Error handling

### Missing dependencies

Activation fails with a structured result containing:

- missing dependency;
- failed probe;
- supported platforms;
- exact remediation command or manual requirement;
- whether another profile remains usable.

The manager does not partially advertise required tool schemas.

### MCP startup failure

Startup has a bounded timeout. Failure closes partially started resources, leaves the session activation unchanged, and stores a short diagnostic reference. Retrying activation starts from a clean state.

### Runtime crash

An MCP crash marks the shared runtime unhealthy and affected activations degraded. The next tool call receives a typed unavailable result. The manager performs bounded restart with backoff; it never loops indefinitely inside a provider turn.

### Concurrent activation

Activation and disable operations are serialized per session and capability ID. Workspace runtime startup is deduplicated across sessions. A session deleted during activation releases any acquired runtime reference.

### Stale tool calls

Calls are settled only against the immutable registry materialization that advertised them. Disabling and re-enabling a pack cannot redirect an old call to a new registration.

### Checkpoint corruption

Checkpoint input is schema-validated before persistence. Database migration defaults existing loops to no checkpoint. Invalid stored JSON is reported as a loop error and omitted from wake prompts rather than preventing the scheduler from processing other loops.

## Observability

Emit structured events for:

- capability activation requested, succeeded, degraded, and failed;
- shared runtime started, reused, stopped, and crashed;
- tool definitions added or removed from a session materialization;
- loop checkpoint updated and loop completion requested;
- per-pack startup latency and tool schema token estimates.

Logs redact environment values, authorization headers, browser storage, and tool arguments marked secret.

`capability_status` exposes user-facing health without requiring raw log inspection.

## Testing strategy

### Unit tests

- manifest decoding, validation, precedence, profiles, and platform filtering;
- deterministic capability ranking;
- session activation persistence;
- pack-aware tool materialization;
- dependency and health-state transitions;
- checkpoint validation, partial updates, and size bounds;
- wake prompt rendering from checkpoint state.
- bounded active-checkpoint context after compaction;

### Integration tests

- two concurrent sessions in one Location receive different tool schemas;
- activation becomes visible on the next provider turn;
- disabling a pack hides future definitions without interrupting an in-flight call;
- shared runtime reference counting and idle shutdown;
- MCP startup failure rolls back activation;
- active pack survives OpenCode restart;
- loop checkpoint survives restart and appears in the scheduled prompt;
- compaction preserves the active loop's objective, evidence summary, and next action through the bounded context source;
- completed adaptive loop stops future admissions.

### Pack smoke tests

- browser: serve a local fixture app, complete a UI workflow, inspect console, and save a screenshot;
- research: retrieve, fetch, and cite a known primary source;
- mobile: launch a fixture app in an available simulator, interact, and collect a screenshot;
- security: detect seeded source, dependency, and HTTP findings in disposable fixtures;
- documents: convert representative PDF, DOCX, XLSX, image, audio, and video fixtures;
- GitHub: exercise read-only commands against a fixture repository, with write tests isolated behind an explicit test credential;
- deploy: build and health-check a local Docker service; provider tests use disposable resources.

### Model evals

Run the configured Qwen model on a versioned suite covering:

- identifying that a missing capability is required;
- choosing the smallest sufficient pack/profile;
- completing browser, research, mobile, security, document, and deployment outcomes;
- updating loop checkpoints with evidence rather than unsupported claims;
- avoiding unnecessary pack activation;
- recovering from a failed tool or missing dependency.

Compare against the current baseline using task completion rate, verified acceptance criteria, incorrect tool-call rate, total provider tokens, time to first useful action, and wall-clock completion time.

## Delivery decomposition

This architecture is delivered as four independently reviewable slices.

### Slice 1: Capability runtime and browser/research packs

- manifest schema and discovery;
- session activation table and service;
- pack-aware ToolRegistry materialization;
- four capability management tools;
- shared runtime lifecycle;
- browser and research manifests/skills;
- browser and research end-to-end tests.

This proves the architecture with one local MCP family and one remote MCP family.

### Slice 2: Loop checkpoints

- checkpoint schema and database migration;
- loop tool extensions;
- scheduled prompt injection;
- restart, compaction, and completion tests.

### Slice 3: Remaining packs

- mobile;
- security;
- documents;
- GitHub;
- deploy and provider profiles;
- platform health checks and installation documentation.

### Slice 4: Evaluation and distribution

- Qwen task suite and baseline comparison;
- context/token instrumentation;
- pack authoring documentation;
- fork installer/release updates;
- migration of the local machine to shipped packs.

Each slice lands only after its focused tests and native build pass. Later slices may refine manifests but must not bypass session-scoped visibility or create a parallel goal lifecycle.

## Acceptance criteria

1. A fresh session advertises only baseline tools and the four capability management tools.
2. Enabling `browser/default` adds Playwright tools on the next turn without restarting OpenCode.
3. Another concurrent session in the same repository does not receive those schemas unless it enables the pack.
4. Disabling the pack removes its schemas on the next turn and eventually stops an unused shared runtime.
5. Browser and research fixture tasks complete end to end with saved evidence.
6. An adaptive loop can persist and update a structured checkpoint, survive restart, inject it on wake, and complete without another goal object.
7. Every shipped pack reports healthy, degraded, or unsupported with actionable diagnostics on the local Mac.
8. Security and deployment tools remain governed by existing permissions and never receive credentials through model-visible manifests.
9. Qwen evals show a higher verified completion rate than the baseline without increasing default tool-schema context beyond the compact capability interface.
10. The feature is documented and installable from the `netsky-prod/opencode` fork on supported platforms.

## Implementation and verification map

The authoring/runtime contract is documented in [capabilities.md](../../capabilities.md), with source-build and release instructions in [fork-release.md](../../fork-release.md). Built-in JSON and skill text use static Bun imports; custom packs and external executables remain outside the binary.

| Criteria | Regression coverage                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 1–4      | Core capability materialization/runtime/tool tests; OpenCode capability e2e and runtime tests          |
| 5        | OpenCode capability e2e; real-browser/Swift fixture verifier tests and live Qwen traces                |
| 6        | Core/OpenCode loop checkpoint, restart, compaction and wake tests                                      |
| 7–8      | Operational pack smoke tests, permission/resource extraction tests and redaction tests                 |
| 9        | Versioned capability eval runner; actual provider schema snapshots and external artifact/SQLite checks |
| 10       | Compiled distribution probe, native build, SDK generator regression, installation tests and docs       |

The SDK's flat OAuth callback requires both `code` and `flowToken`; the generator dependency patch preserves required bodies without making optional legacy bodies mandatory. The eval report includes the effective task digest as well as source identity. These mappings identify checks, not a claim that every platform or live task has passed; release evidence records actual commands and results.
