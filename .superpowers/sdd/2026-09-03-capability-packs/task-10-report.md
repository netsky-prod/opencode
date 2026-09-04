# Task 10 Report: Capability Observability

## Outcome

Capability activation, runtime ownership, provider-visible definition changes, adaptive-loop checkpoints, completion requests, startup latency, and schema-size estimates now publish typed live events through the existing EventV2 bus. A single capability event boundary reconstructs an allowlisted payload and suppresses ambient workspace location metadata. Publication is bounded and cannot fail or interrupt the primary operation.

Schema estimates use stable-key UTF-8 JSON serialization of the final materialized tool definitions after capability and permission filtering. The documented approximation is `ceil(bytes / 4)` with baseline, activated, and delta totals; it has no tokenizer dependency and never executes a tool.

## TDD Evidence

The initial RED run of `bun test test/capability/event.test.ts test/capability/token-estimate.test.ts` failed both files because the new modules did not exist. A second privacy RED reproduced an absolute workspace location on the actual EventV2 envelope. The central boundary then gained explicit location suppression while ordinary EventV2 location behavior remained unchanged.

A self-review RED also exercised the OpenCode EventV2 bridge directly and proved that it reintroduced the location when forwarding an explicit suppression marker. The bridge now preserves explicit suppression, with its ordinary routed-event behavior unchanged.

Independent review round 1 found four Important issues. Dedicated RED tests reproduced each one: locale-sensitive non-ASCII ordering, an unbounded full-schema materialization cache, an activation trace of `catalog:get -> activation.requested -> catalog:get`, and a suppressed event leaking its instance path through GlobalBus while disappearing from instance SSE. The fixes use explicit UTF-16 code-unit sorting; SHA-256-only, 256-entry LRU materialization snapshots; one activation catalog read after the requested event with selected-profile runtime counts; and process-local weak routing metadata carried through a symbol-keyed publish option. Direct EventV2, GlobalBus, and real HTTP SSE tests now prove that the event reaches only its instance stream without a public location field or path-bearing GlobalBus copy.

Review round 2 found that durable EventV2 publication cloned the event before notification and initially lost that process-local route. A dedicated RED observed `undefined` routing in the durable listener and a path-bearing durable GlobalBus event. The route is now transferred to the committed envelope before notification; direct EventV2, GlobalBus, and real instance SSE durable regressions are GREEN.

Focused and broader GREEN verification:

- Core affected suite: 244 tests passed in the initial broad run; the final post-review affected suite passes 191 tests.
- OpenCode runtime/E2E/bridge/SSE slice passes 24 tests.
- Core and OpenCode typechecks passed.
- Migration check reported no schema changes.
- Prettier checks and touched-file lint passed with zero errors.
- Repo-wide lint remains blocked by one pre-existing octal-escape error in the session UI prompt input; it is outside Task 10.

## Real Qwen Gate

`/usr/bin/screen` was used as the tmux-equivalent because tmux is unavailable. A disposable nested Git fixture supplied one project-local capability and one deterministic stdio MCP tool. Before spending another model run, a deterministic CLI-equivalent provider preflight executed search, status, enable, canonical ping, and disable through the real OpenCode process and real MCP adapter. Its injected failure cleanup also passed.

The fresh Qwen run then completed exactly:

1. `capability_search`
2. `capability_status`
3. `capability_enable`
4. the newly materialized fixture ping tool
5. `capability_disable`

All five calls completed. Thirteen actual published EventV2 envelopes were captured with an isolated, temporary file sink placed after `publishEvent`; the sink was removed before final verification. The observed lifecycle included requested, runtime started, startup measured, activation succeeded, definitions added, definitions removed, and runtime stopped. Schema size moved from 18,051 to 18,264 bytes and from 4,513 to 4,566 estimated tokens, a delta of 213 bytes and 53 tokens, then returned to baseline.

Independent checks found no location or metadata envelope, secret sentinel, hostname, URL, personal path, Session ID, raw tool input, goal-tool use, or loop-tool use. The concise sanitized result is `live/slice-4/task10-result.json`; raw traces and fixture files remain local and ignored.

The review fixes preserve the successful live gate's public event types, order, payloads, successful one-runtime count, and ASCII fixture schema totals. The routing change is process-local and excluded from captured envelopes; its newly restored instance delivery is covered independently through the real HTTP SSE stack. No second model run was needed because none of the successful gate's model-facing behavior or asserted envelope data changed.

Independent review round 3 accepted the task with no remaining Critical or Important findings. The reviewer's fresh verification passed 83 Core tests, 24 OpenCode tests, and the diff check.

## Cleanup

The owned screen session, runner process group, fixture MCP, deterministic mock provider, and test listener were all absent after cleanup. The temporary EventV2 file sink was removed before final tests. No raw trace, disposable fixture, host, path, credential, timestamp, or Session ID is tracked.
