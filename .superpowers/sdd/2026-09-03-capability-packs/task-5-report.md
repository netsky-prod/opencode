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
