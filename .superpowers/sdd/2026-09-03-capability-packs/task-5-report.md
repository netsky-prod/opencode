# Task 5 Report: Capability Management Tools and Runtime Wiring

## Outcome

Implemented the four always-on capability management tools: `capability_search`, `capability_enable`, `capability_disable`, and `capability_status`. Search is capped at ten catalog summaries. Enable validates profiles and platform support, probes dependencies, acquires every required runtime, and persists activation only after all fallible preparation succeeds. Failures release newly acquired resources and leave prior activation unchanged. Successful responses identify the tools and skills available on the next materialization.

Runtime ownership is tracked per Session and capability. Disabling persists the inactive state before releasing held references and registrations, so future schemas disappear immediately. Persisted active rows are reconstructed lazily before materialization; packs whose runtime resources cannot be reacquired are withheld rather than advertised with unusable tools. Runtime calls pass through the existing permission service using the canonical tool action.

Added the exact capability-discovery guidance to built-in system context. Core keeps `CapabilityRuntime` as an explicit unbound host requirement, while OpenCode supplies its concrete adapter through the HTTP location-service composition.

## TDD Record

### RED

1. Added capability-tool tests first; the suite failed because `@opencode-ai/core/tool/capability` did not exist.
2. Added built-in system-context expectations first; they failed because the required capability-discovery sentence was absent.
3. Added composition coverage for the unbound Core runtime and OpenCode replacement before completing service wiring.
4. Added dependency, runtime rollback, restart reconstruction, permission, disable-order, and redaction regressions before their implementation paths were complete.

### GREEN

- Core focused suites: 34 passed, 0 failed; `tsgo --noEmit` exited 0.
- OpenCode runtime/composition and HTTP location suites: 8 passed, 0 failed; `tsgo --noEmit` exited 0.
- `git diff --check` passed.

## Implementation Notes

- `CapabilityTool` owns scoped acquired-runtime references and dynamically registers runtime tools with capability/profile origins.
- Dependency probes use the application process abstraction with bounded execution and do not expose command output in tool results.
- Required probe or runtime failures produce actionable, sanitized remediation and never write activation state.
- Optional unavailable dependencies/runtimes produce degraded status without blocking otherwise usable profiles.
- Runtime tool input schemas remain bounded JSON-schema objects and runtime resources are resolved at call time, allowing restarted adapters to replace handles safely.
- Tool materialization runs registered preparation hooks before reading activation state. The capability hook reconstructs persisted runtime ownership and returns unavailable pack IDs to exclude from that materialization.
- `capability_status` exposes health states and timestamps without raw subprocess output, secrets, or adapter internals.
- Core composition fails clearly when no host runtime replacement is supplied; the OpenCode server passes its concrete adapter to `buildLocationServiceMap`.

## Verification

From `packages/core`:

```text
bun test test/tool-capability.test.ts test/system-context/builtins.test.ts test/location-layer.test.ts test/capability/materialization.test.ts test/application-tools.test.ts && bun typecheck
34 pass, 0 fail
tsgo --noEmit: exit 0
```

From `packages/opencode`:

```text
bun test test/capability/runtime.test.ts test/server/httpapi-v2-location.test.ts && bun typecheck
8 pass, 0 fail
tsgo --noEmit: exit 0
```

## Concerns

- Runtime ownership is intentionally process-local. Persisted activation is authoritative across restarts, while handles are rebuilt lazily on the first subsequent materialization.
- A failed lazy reconstruction hides the affected capability's runtime tools for that turn; status remains available so the model can surface remediation or retry enablement.

## Review Fix Round 1

### Findings Addressed

1. Capability reconciliation now shares the per-Session/capability lock with enable and disable. Under that lock it re-reads durable activation and the current catalog pack, compares sorted profiles plus a manifest fingerprint covering profiles, runtimes, dependencies, platforms, and skills, and releases only the held identity it observed. Removed or changed manifests are withheld and their old registrations/references are released before reconstruction.
2. Dynamic registration is an uninterruptible preparation boundary. Registration failure rolls back partial scoped registrations and releases every reference returned by runtime activation before returning an error; activation persistence remains last.
3. Runtime tool authorization never uses wildcard resources. Every request contains `mcp:<serverID>:<tool>` followed by at most 31 distinct, bounded string leaves from the decoded input; saved approval is limited to the canonical MCP resource. Target-specific denial prevents the runtime call.
4. OpenCode now owns one adapter-bound location-map composition in `src/location-services.ts`. Session system context, agents, debug commands, file/PTY handlers, the HTTP server, and relevant tests use it. Core no longer exports an unusable default map layer with an unbound capability runtime.
5. Status classifies a missing required dependency as `failed`, an invalid persisted profile selection as `unavailable`, and optional failures only as degradation.
6. Enable responses retain the backward-compatible `tools` and `skills` fields while adding explicit `availableTools`, `availableSkills`, and `permissionFiltered: true`. Both old and new lists are filtered through the invoking agent's effective deny rules, so denied names are not claimed as available.
7. Every materialization preparation reconciles all held Session IDs against `SessionStore`. Cascade-deleted Sessions release matching held identities on the next prepare in that Location; the Location finalizer remains the terminal cleanup boundary.

### Review RED Evidence

- Registration failure left both newly acquired runtime references held.
- A prepare racing with disable reacquired a now-disabled runtime from its stale activation snapshot.
- Removed and replaced manifests continued advertising the old runtime tool and did not release its reference.
- Preparing another Session after cascade deletion did not release the deleted Session's held reference.
- Required dependency failure and invalid persisted profiles were reported as active.
- Enable claimed tool/skill names denied by the invoking agent.
- Runtime permission checks used wildcard resource/save values and did not observe a nested target-specific deny.
- The shared OpenCode location composition module did not exist, while several callsites still imported Core's unbound default layer.

### Review GREEN Evidence

From `packages/core`:

```text
bun test test/tool-capability.test.ts test/system-context/builtins.test.ts test/location-layer.test.ts test/capability/materialization.test.ts test/application-tools.test.ts test/permission.test.ts && bun typecheck
53 pass, 0 fail
tsgo --noEmit: exit 0
```

From `packages/opencode`:

```text
bun test --timeout 10000 test/capability/runtime.test.ts test/server/httpapi-v2-location.test.ts test/session/prompt.test.ts test/session/system.test.ts test/agent/agent.test.ts test/server/httpapi-file.test.ts test/server/httpapi-pty.test.ts test/server/httpapi-v2-pty.test.ts && bun typecheck
131 pass, 1 skip, 0 fail
tsgo --noEmit: exit 0
```

Targeted lint completed with 0 errors. Its warnings were existing style findings in the touched legacy files plus test-only narrow fixture casts. `git diff --check` passed before commit.

### Review-Fix Concerns

- Deleted-Session cleanup is intentionally prepare-driven because Core has no Location-scoped Session deletion subscription. It is bounded by the held Session set and also runs under the existing Location finalizer.

## Review Fix Round 2

### Findings Addressed

1. Permission-resource extraction now fails closed with the typed `CapabilityTool.PermissionResourceOverflow` condition when the canonical resource plus distinct input leaves would exceed 32 resources, an individual resource exceeds its length bound, or traversal would exceed 256 nodes. The runtime tool converts that condition to `ToolFailure` before invoking permission handling or the runtime. Cycles are tracked by identity and cannot cause unbounded traversal.
2. Capability runtime keys now include a hash of both the current manifest fingerprint and the selected runtime definition. Shared registration keys include that fingerprinted runtime key as well. A changed manifest can therefore start and register alongside an old runtime still referenced by another Session; the old reference is released only when its owning Session reconciles or the Location closes. The OpenCode adapter parses the runtime ID separately from the fingerprint while retaining direct legacy-key compatibility.

### Review RED Evidence

- With 31 distinct filler leaves after the canonical resource, a denied target in the next input field was silently omitted and the runtime executed.
- A cyclic chain exceeding 256 nodes reached the runtime and later failed during unrelated output serialization instead of failing at the permission boundary.
- Two Sessions enabling old and changed definitions received the same `browser/playwright` runtime key, preventing the real runtime service from starting the new definition while the old Session retained a reference.

### Review GREEN Evidence

From `packages/core`:

```text
bun test test/tool-capability.test.ts test/system-context/builtins.test.ts test/location-layer.test.ts test/capability/materialization.test.ts test/application-tools.test.ts test/permission.test.ts && bun typecheck
56 pass, 0 fail
tsgo --noEmit: exit 0
```

The combined OpenCode callsite run completed with 130 passed, 1 intentional skip, and one timeout in `applies plugin shell environment before forced PTY values`. Per the task brief, the PTY suite was rerun in isolation:

```text
bun test --timeout 10000 test/server/httpapi-v2-pty.test.ts && bun typecheck
4 pass, 0 fail
tsgo --noEmit: exit 0
```

The isolated test completed in 503.62 ms. Targeted lint completed with 0 errors, and `git diff --check` passed before commit.
