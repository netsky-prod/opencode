# Native capability and MCP manager report

## Delivered

- Added one native `Capabilities & MCPs` dialog exposed by both `/capabilities` and `/mcps`.
- Inventory works on the home route without a session. Pack activation and deactivation require the currently selected real session and call the generated capability client directly; no prompt or transcript message is created.
- Pack rows show source, active profiles, runtime state, platform metadata, and remediation. Failed and unsupported activation responses are errors rather than success toasts. Stale active packs whose manifests disappeared remain deactivatable.
- Added guided MCP setup and editing for local command arrays and remote HTTP(S) URLs, independent global/project storage, independent always-on/pack-only exposure, enabled state, masked environment/header inputs, direct health checks, and remote OAuth authentication.
- Existing redacted commands and URLs are display-only. Blank connection and secret fields are omitted from PATCH payloads so the backend preserves stored values. Submitted secret values are redacted from surfaced failures.
- Existing MCP writes use the entry revision; new definitions use the selected configuration-scope revision. Save and attach requests show a locked working screen and only report success when the API returns data.
- Existing always-on definitions require confirmation before every edit because save reconnects the connection. Exposure changes also require confirmation.
- MCP attachment writes references, not resolved credentials. Existing pack attachment uses that pack's source scope and revision. New packs ask separately for target storage scope and use an empty revision. Requests also include the selected MCP source scope and revision so a shadowed or concurrently edited definition cannot be used silently.
- Same-name global/project definitions are visibly labeled. Connection checks always include the selected entry scope; global entries reported as shadowed remain explicit.
- Added a concealed `DialogPrompt` mode that keeps actual secret values outside the rendered terminal while preserving the confirmed input value.
- Kept one stable searchable manager mounted while inventory resolves, preventing an OpenTUI dynamic-root transition from blanking the real modal. The title changes from loading to ready, and locked filters are blurred/suspended so early keyboard input is not absorbed. The loading-to-ready transition is covered through an actual `dialog.replace` modal render.
- Added configurable `capability_list` and Space activation bindings. Public terminal/update text in `app.tsx` now says Netsky Code / `netsky`; internal compatibility identifiers remain unchanged.

## Backend contract consumed

The TUI uses the generated `sdk.client.capability` methods: `list`, `enable`, `disable`, `saveMcp`, `checkMcp`, and `attachMcp`. It passes selected-session IDs only for activation, MCP source scope to check/attach, target pack scope separately, entry/pack conflict revisions, and confirmation flags for disruptive edits or migrations.

## Verification

Run from `packages/tui` with Bun 1.3.14:

- `bun typecheck` — passed.
- `bun run test` — 216 passed, 1 pre-existing skipped, 0 failed, 8 snapshots, 526 expectations. Existing noisy `/tmp/opencode/state/kv.json` warnings from unrelated diff-viewer fixtures remained non-failing.
- Focused capability, prompt, and config tests — 34 passed, 0 failed, 93 expectations.

Run from `packages/opencode`:

- `bun typecheck` — passed against the regenerated capability SDK and backend implementation.

Focused coverage includes inventory without a session, status/remediation rendering, exact pack and MCP name rules, profile payloads, missing-session rejection without a client call, failed/unsupported and thrown activation errors, conflict revisions, local/remote PATCH construction, omitted secrets, terminal secret concealment, selected MCP scope, independent target pack scope, exposure/reconnect confirmations, shadow labeling, and stale-pack deactivation eligibility.

## Native acceptance route

The release PTY pass should exercise the compiled `netsky` executable in an isolated fixture:

1. On the home route, enter `/capabilities`; verify inventory appears and Space on a selected pack reports that a session is required without creating a chat message.
2. Enter `/mcps`; verify it opens the same manager.
3. Open a real session, enter `/capabilities`, choose a pack, toggle profiles with Enter, and activate with Space. Verify the success copy says the change applies at the next provider-turn boundary and no user/assistant message was generated.
4. Exercise `Add MCP server` with controlled local and remote fixtures. Verify secret characters never render, save/check errors remain visible, and persisted rows distinguish scope from exposure.
5. On an MCP row, exercise Edit, Check, Authenticate (remote only), and Attach. Verify always-on edits warn, attachment to an existing pack uses its scope, and new-pack attachment asks for global/project storage.
6. With same-name global and project MCP entries, verify the global row says it is shadowed and scoped check/attach never mutates the project entry accidentally.

Compiled-native/Qwen acceptance was run by the release root because it owns the executable build, installation backup, controlled real MCP fixtures, and real provider session. The earlier full pass completed successfully in `tmp/netsky-native-qYxnjD/result.json`: native launch, MCP creation and check, pack creation, activation, session isolation, zero fabricated activation messages, a real Qwen tool call returning fixture data, and deactivation all passed. After fixing the loading transition, an isolated native smoke pass in `tmp/netsky-manager-smoke-fJnLFG/manager.txt` confirmed `/capabilities` reaches the interactive inventory through the compiled binary.

## Compatibility note

The `/docs` action targets the Netsky repository README. Internal `opencode.*`, package namespaces, environment variables, and persistence paths stay compatible by design.
