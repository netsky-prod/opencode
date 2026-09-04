# Task 4 Report: Session-Aware Tool and Skill Materialization

## Outcome

Implemented session-aware Core V2 materialization for tools and skills. `ToolRegistry.materialize` now requires a Session ID, filters capability-owned registrations against that session's active pack/profile set before applying permission visibility, and leaves untagged or configured non-capability tools unchanged. The V2 runner passes the current Session ID into both tool materialization and skill guidance.

Tool decorations now support immutable `Tool.Origin` metadata through `Tool.withOrigin`. Existing materialization settlement semantics remain identity-bound: disabling a capability changes future materializations without invalidating the unchanged registration captured by the current provider turn, while removing or replacing that registration produces a stale-call result.

Capability-pack skills are materialized from the active profiles in `CapabilityCatalog`. Guidance and the `skill` tool share the same session-filtered list. Existing untagged skills retain precedence on name collisions, unavailable packs are omitted, and disabling a pack affects future guidance/loading without rewriting prior conversation history.

## TDD Record

### RED

1. Added `test/capability/materialization.test.ts` before production changes. The two tool tests failed with `TypeError: Tool.withOrigin is not a function`, proving the origin-decoration/materialization boundary was absent.
2. Added the skill visibility/loading regression before changing guidance or the skill tool. The tool tests remained green, while the skill test failed because the old one-argument guidance API interpreted the Session ID as the selection and returned an empty baseline (`Expected to contain: "<name>public</name>"; Received: ""`).
3. A broader tool-suite run exposed six unbound-Location errors in test compositions after `ToolRegistry` acquired `CapabilityState`. Those test layers were updated with an explicit empty capability-state replacement.

### GREEN

- Focused materialization, guidance, skill-loader, and registry run: 27 passed, 0 failed; Core `tsgo --noEmit` passed.
- V2 runner and recorded-runner suites: 88 passed, 0 failed.
- Broader Core tool and application-tool suites: 119 passed, 0 failed.
- `git diff --check` passed before the report was written.

## Implementation Notes

- `Tool.withOrigin` composes with permission decoration and freezes a copied origin record.
- Capability filtering accepts an active pack when no profile is attached to the origin, and otherwise requires the exact active profile.
- `builtin`, plugin, or MCP origins without a capability owner remain visible; this preserves configured non-capability integrations.
- The materialized registration map remains a per-provider-turn snapshot, while settlement revalidates the current registration identity to reject removals and replacements.
- Active pack skills are selected only from the profiles enabled for the requesting Session. Missing manifests and missing/changed profiles produce no pack skills.
- Existing untagged skills win same-name conflicts, preserving their prior lookup and guidance behavior.

## Verification

Run from `packages/core`:

```text
bun test test/capability/materialization.test.ts test/skill/guidance.test.ts test/tool-skill.test.ts test/session-runner-tool-registry.test.ts && bun typecheck
27 pass, 0 fail
tsgo --noEmit: exit 0
```

Additional verification:

```text
bun test test/session-runner.test.ts test/session-runner-recorded.test.ts
88 pass, 0 fail

bun test test/tool-*.test.ts test/application-tools.test.ts
119 pass, 0 fail
```

## Concerns

- A direct per-file `bunx oxlint` invocation could not parse the repository's existing `.oxlintrc.json` because that CLI invocation rejects `options.typeAware` outside its expected root configuration shape. Required tests and Core typechecking are clean.
- A capability runtime shared by several profiles must register origins consistently with the profile exposure it intends. The current origin contract supports one optional profile per decorated registration; capability-only origins intentionally mean visibility under any active profile for that pack.

## Review Fix Round 1

### Findings Addressed

1. A materialization is now bound to the Session ID that created it. Settlement with another Session ID returns a normal model-facing error before tool execution or output retention, so the caller cannot redirect a captured materialization's effects or stored output to another Session.
2. Registration precedence is now visibility-aware. Materialization walks each Location registration stack newest-to-oldest under the captured active pack/profile snapshot and falls back to the application registration only when no visible Location registration exists.
3. Settlement re-resolves the current registration under that same captured visibility snapshot before comparing identities. A new visible registration makes the call stale; an overlay owned by a capability active only in another Session neither hides nor stales the advertised configured tool.
4. Permission filtering still runs after the highest visible registration is resolved, so a denied winner does not reveal a lower registration.

### Review RED Evidence

- Cross-session settlement executed the tool and returned retained output under the second Session instead of the expected materialization-ownership error.
- A visible `browser/default` registration beneath an invisible `browser/diagnostics` registration disappeared entirely because the previous implementation selected only the absolute stack winner before filtering.
- Adding a capability overlay active in another Session caused settlement of an already advertised application tool to return `Stale tool call` because stale validation also selected the absolute stack winner.

The focused test run was deterministic: 3 passed and the 3 new regressions failed for the exact behaviors above.

### Review GREEN Evidence

- Focused materialization, guidance, skill-loader, and registry suites: 30 passed, 0 failed; Core `tsgo --noEmit` passed.
- V2 runner and recorded-runner suites: 88 passed, 0 failed.
- Broader Core tool and application-tool suites: 119 passed, 0 failed.

### Review-Fix Concerns

- No new runtime concern. The registration resolver is synchronous and captures only immutable activation/profile sets for the provider turn; tool execution remains captured once settlement starts.
