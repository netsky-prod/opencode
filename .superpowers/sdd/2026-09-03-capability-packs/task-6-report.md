# Task 6 Report: Browser and Research Built-In Packs

## Outcome

Added two built-in capability packs through the existing embedded catalog registration path:

- `browser/default` starts pinned `@playwright/mcp@0.0.80` for navigation, inspection, interaction, and screenshot evidence.
- `browser/diagnostics` starts pinned `chrome-devtools-mcp@1.8.0` only when console, network, source, or performance diagnostics are needed.
- `research/default` references the configured Federated Research MCP endpoint, the Context7 MCP endpoint, and guidance for direct primary-source inspection through the existing `webfetch` tool.

The built-in skills require observable outcome checks, artifact paths, primary-source fetching, citation metadata, uncertainty separation, and independent verification. Manifest environment values remain unresolved `${NAME}` references, and no bearer token or resolved credential is embedded in the shipped assets.

`PluginInternal` now supplies the capability catalog to internal plugins and loads the built-in capability plugin in the standard scoped plugin boot sequence.

## TDD Record

### RED

The built-in manifest test was written first and failed because `@opencode-ai/core/plugin/capability` did not exist.

### GREEN

The built-in plugin decodes both JSON assets with the strict capability manifest schema and registers them as immutable embedded catalog sources. The focused Core test then passed with exact browser commands, profiles, research endpoint references, environment-reference validation, loaded skills, and a credential-leak assertion.

The OpenCode E2E uses real hidden MCP transports and the real capability runtime adapter against deterministic local fixture servers. It proves:

- browser tools are absent before enable and in a second Session;
- the enabled Session navigates and inspects a local page and writes a valid screenshot artifact;
- research returns preserved citation metadata and the primary-source URL is fetched through the real `webfetch` tool;
- disabling both packs removes their schemas;
- advancing the test clock beyond the runtime idle interval does not resurrect inactive schemas.

## Verification

From `packages/core`:

```text
bun test test/plugin/capability.test.ts test/capability/manifest.test.ts test/capability/catalog.test.ts test/capability/materialization.test.ts test/tool-capability.test.ts test/location-layer.test.ts && bun typecheck
43 pass, 0 fail
tsgo --noEmit: exit 0
```

From `packages/opencode`:

```text
bun test test/capability/e2e.test.ts test/capability/runtime.test.ts && bun typecheck
8 pass, 0 fail
tsgo --noEmit: exit 0
```

`git diff --check` and Prettier checks passed.

## Concerns

- The live Qwen/tmux gate is intentionally not run in this worker; the root agent owns Task 6 Step 5 after review.

## Review Fix Round 1

The adapter now resolves exact `${NAME}` references before classifying local versus remote MCP transports. For remote transports, manifest `environment` entries become HTTP headers, so the Federated Research authorization reference reaches the server without entering capability status or model-visible tool data. Missing variables fail with an actionable variable name, and resolved values are redacted from startup failures.

Built-in skill Markdown is now carried by embedded catalog registration itself. The catalog assigns stable virtual `/builtin/capabilities/...` locations and no longer requires source-tree paths or `realpath` access to materialize shipped skills.

The E2E now boots the real `PluginInternal` and `CapabilityCatalog` path, inspects the shipped manifest identity, exact pinned browser commands, profiles, and embedded skill text, then exercises those packs through adapter-real fixtures. The browser fixture is launched by the exact shipped `npx -y @playwright/mcp@0.0.80` command through a deterministic executable shim because `npx` is unavailable in this environment. It validates Playwright-compatible navigate, snapshot, and screenshot schemas and records process closure. The research fixture exercises the literal Federated env references, authorization header, Context7 profile member, citation metadata, and real `webfetch` source retrieval. After disable and a 31-second test-clock advance, the browser child-process closure marker proves actual idle teardown rather than only schema hiding.

Review-fix verification:

```text
packages/core: 59 capability/plugin tests passed, 0 failed
packages/opencode: 11 capability tests passed, 0 failed
packages/core: tsgo --noEmit exit 0
packages/opencode: tsgo --noEmit exit 0
targeted oxlint: exit 0
git diff --check: exit 0
```

## Live-Gate Blocker Fix: Legacy Session Tool Bridge

The first live Qwen attempt showed that `opencode run` still resolved tools through the legacy `SessionTools.resolve` path, while capability tools and activated runtime tools existed only in the per-location Core registry. A regression was added at that exact boundary before implementation; its RED result advertised zero `capability_*` tools instead of the required four.

`SessionTools.resolve` now acquires the existing Core services for the session's real directory and workspace, waits for the shipped capability catalog plugin, and captures one immutable Core materialization per provider turn. It bridges only the four management tools plus tools belonging to active pack/profile runtimes, so Core legacy-equivalent built-ins are not duplicated. Activated pack skills are dispatched through Core's session-aware skill settlement while unrelated skills keep the legacy implementation.

The bridge translates legacy permission rules for schema filtering, retains legacy permission and plugin hooks around execution, maps Core structured output and managed paths into metadata, maps Core file content into legacy attachments, retains aborted-call completion behavior, and delegates stale/cross-session enforcement to the captured Core materialization. Agent, system-prompt, and session-prompt layers now share one `LocationServiceMap` node, so the bridge does not create a second runtime or capability-state owner. Capability catalog/state are explicit members of the Core location service set.

The real shipped browser pack exposed an additional package-runtime issue during GREEN: its virtual embedded skill directory was also being used as a process `cwd`. Built-in dependency probes now use the host's existing working directory while project/global packs retain their manifest directory.

The regression uses persisted sessions, the shipped `browser/default` manifest, and the exact pinned `npx -y @playwright/mcp@0.0.80` command through the deterministic adapter-real fixture. It proves:

- exactly four `capability_*` schemas initially;
- no same-turn runtime schema mutation after `capability_enable`;
- only the three Playwright tools, and no diagnostics tools, on the next turn;
- real navigation, snapshot structured output, screenshot artifact and file attachment mapping;
- shipped `browser-testing` skill materialization;
- isolation of a second session;
- stale captured runtime calls fail after disable, and a new turn hides the tools.

Blocker-fix verification:

```text
packages/core: 44 capability/plugin/location tests passed, 0 failed
packages/opencode: 70 passed, 1 pre-existing skip, 0 failed
packages/core: tsgo --noEmit exit 0
packages/opencode: tsgo --noEmit exit 0
targeted oxlint: exit 0 (pre-existing warnings only)
git diff --check: exit 0
```

The live Qwen gate was not rerun in this worker, as requested; the root agent owns that rerun after review.
