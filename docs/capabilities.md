# Capability packs

Capability packs add tools and guidance when a session needs them. They do not replace the model, permissions, or durable [loop](./loop.md). A fresh session exposes four management tools: `capability_search`, `capability_status`, `capability_enable`, and `capability_disable`. Other ordinary OpenCode tools remain available; inactive packs do not contribute MCP schemas or skill contents.

Ask the agent to discover a capability, inspect its status, enable the smallest applicable profile, and verify a concrete outcome. Enabled tools become available on the next provider turn. Enabling a pack is not evidence that the task succeeded.

## Included packs

| Pack      | Profiles                 | Runtime and prerequisites                                                                                     |
| --------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| browser   | default, diagnostics     | Pinned Playwright MCP or Chrome DevTools MCP; Node, npm/npx, and an installed browser                          |
| research  | default                  | Federated Research MCP and Context7; configured endpoint and authorization                                    |
| mobile    | ios, android             | Guidance and probes for Xcode/simulator, Flutter, adb; iOS is macOS-only                                      |
| security  | static, dynamic          | Guidance and probes for Semgrep, CodeQL, Gitleaks, OSV, Trivy; ZAP, Nuclei, Schemathesis, Nmap, mitmproxy, k6 |
| documents | default                  | Guidance and probes for MarkItDown, Poppler, Tesseract, FFmpeg/ffprobe                                        |
| github    | default                  | GitHub CLI guidance, installation and authentication probes                                                   |
| deploy    | core, runpod, cloudflare | Docker/Compose, runpodctl, or Wrangler guidance and probes                                                    |

Operational packs use existing shell tools; they do not bundle these external programs or install them automatically. Browser/research supply MCP tools. Missing optional programs yield `degraded`, not fabricated success. Pinned MCP packages can require a first-run download. Install their dependencies before latency-sensitive work.

## Scope, lifecycle, and permissions

Activations persist per Session ID in SQLite. Another session does not inherit them. Compatible runtime processes are shared within a Location using reference counting; releasing one session must not interrupt another. The last release schedules idle shutdown. After a process restart, persisted activations are re-materialized as needed, not treated as proof that the old process is still alive.

Pack tools keep the original permission checks, including rules for individual tools and extracted resources. Permission hints describe likely operations; they do not grant access. Disabling removes tools and skills from subsequent turns. Previously written artifacts remain on disk.

Use `capability_status` for profile-scoped diagnostics:

- `healthy`: required checks/runtime are available.
- `degraded`: some optional checks/runtime failed; inspect remediation before proceeding.
- `failed`: a required prerequisite or runtime failed.
- `unsupported`: the selected profile cannot run on this platform.
- `unavailable`: an activation references a manifest that is no longer installed.

Overall pack state can also be `installed` or `active`. Check the individual `profileStatus` rather than equating installation with readiness. Status returns remediation and variable names, never resolved credentials.

## Author a pack

Create `capability.json` plus any referenced Markdown files in one of:

1. `.opencode/capabilities/<pack>/` in the project (highest precedence).
2. `${XDG_CONFIG_HOME:-~/.config}/opencode/capabilities/<pack>/` globally.
3. Built-in assets embedded in the fork binary (lowest precedence).

A higher-precedence manifest replaces the whole pack with the same ID; profiles are not merged. IDs use lowercase letters/digits with optional hyphens, starting with a letter. Unknown fields, duplicate IDs, missing references, and escaping skill paths are rejected.

Minimal remote MCP example:

```json
{
  "id": "team-research",
  "version": 1,
  "description": "Search the team's evidence index.",
  "platforms": ["darwin", "linux"],
  "skills": [{ "name": "evidence", "description": "Verify cited evidence.", "path": "evidence.md" }],
  "runtimes": [
    {
      "id": "index",
      "type": "mcp",
      "command": ["${TEAM_RESEARCH_URL}"],
      "environment": { "Authorization": "${TEAM_RESEARCH_AUTHORIZATION}" },
      "timeoutMs": 30000
    }
  ],
  "profiles": {
    "default": { "description": "Search and fetch evidence.", "skills": ["evidence"], "runtimes": ["index"] }
  }
}
```

`version` is currently exactly `1`. A runtime has an ID, type, command array, optional environment mapping, `optional` (default false), and `timeoutMs` (default 15000). Optional `tools` declares known upstream names for collision checking; it is not an access allowlist. OpenCode's current adapter supports `type: "mcp"`; `cli` is reserved by the schema and fails explicitly in this adapter. Use a guidance-only profile with an empty runtime array for CLI workflows.

A single URL command creates a remote MCP connection; its environment mapping becomes HTTP headers. Other command arrays start a local stdio MCP process. Use exact package versions for distributable runtimes. Resolved MCP tool names are namespaced as `<pack>_<runtime>_<sanitized-upstream-name>` and collisions are rejected.

Environment substitution requires a whole value such as `${TEAM_RESEARCH_URL}`, not interpolation inside a string. Missing or empty variables fail with the variable name. For a bearer header, the environment variable must contain the complete `Bearer …` value. Do not put keys in manifests, prompts, committed shell scripts, or reports.

Profiles reference declared skill/runtime IDs and may narrow `platforms`. Optional `dependencies` contains `{ "id", "check": ["program", "--version"], "optional", "profiles" }`; omitting `profiles` applies the check to every profile. Keep checks read-only and fast. Markdown paths must stay inside the pack directory, including after symlink resolution.

The supported platform literals are `darwin` and `linux`. Optional `permissions` metadata has this shape:

```json
{
  "permissions": {
    "hints": [{ "action": "bash", "resource": "docker compose *" }],
    "servers": {
      "index": { "type": "remote", "url": "https://example.org/mcp" }
    }
  }
}
```

`hints` contains action/resource descriptions, not grants or enforced rules. `servers` maps IDs to Core MCP configuration objects: local `{ type: "local", command: [...] }` or remote `{ type: "remote", url: "..." }`, with the optional fields defined in `packages/core/src/config/mcp.ts`. In the current implementation this server metadata participates in discovery; it does not launch servers or replace `runtimes`. Keep credentials out of this metadata. Actual authorization comes from the session's existing OpenCode permission policy.

## Migrate existing research MCP configuration

Existing global MCP connections remain supported. Migration is opt-in:

1. Back up the OpenCode config and identify the exact Federated Research and Context7 entries. Leave unrelated MCPs intact.
2. Supply `FEDERATED_RESEARCH_MCP_URL` and `FEDERATED_RESEARCH_AUTHORIZATION` in the environment of the process that starts OpenCode. Use the full authorization header value. A service/container needs its own secret injection; a shell export does not configure a remote service.
3. In a fresh session, inspect `research/default`, enable it, call search and fetch, and verify the returned source. Check status for both required MCP runtimes.
4. Only after that succeeds, disable the equivalent global MCP entries to avoid duplicate always-visible tools. Restart OpenCode and verify another fresh session exposes no research schemas until activation.

To roll back, re-enable the original MCP entries and disable the pack. Do not delete credentials or the research server. A project override can change transports, profiles, or the Context7 configuration without editing the binary.

## Checkpoints and evidence

Adaptive loops use `loop_checkpoint` for the shared objective, acceptance criteria, verified facts/evidence, uncertainty, decisions, blockers, artifacts, and next action. They continue through `loop_wakeup`; there is no separate goal entity. A checkpoint helps resume work after compaction/restart but cannot itself prove that a build, browser check, or deployment succeeded. Preserve inspectable artifacts and mark completion only after checking them.

## Installation and verification

Follow the [fork release runbook](./fork-release.md). Manifests and skills are static imports embedded in native binaries; no adjacent source checkout is needed. Custom manifests and external programs are separate user-managed resources.

From `packages/opencode`, run `bun test test/capability/distribution.test.ts` to compile and execute a native asset probe outside the checkout, and `bun test test/capability/e2e.test.ts` for fresh-schema/session-isolation checks. The [Qwen eval runner](../packages/opencode/eval/capability/README.md) compares externally verified outcomes with and without capabilities. Fixture integration scores are not a general-purpose model-quality benchmark.
