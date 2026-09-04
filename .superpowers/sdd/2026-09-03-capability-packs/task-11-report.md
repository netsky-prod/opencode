# Task 11 report — Versioned Qwen Evaluation Suite

## Outcome

Implemented the versioned capability evaluation runner, externally verified scoring, deterministic JSON/Markdown reports, strict four-schema acceptance gate, privacy redaction, owned-process cleanup, and a real Qwen baseline/candidate gate through the actual OpenCode CLI/provider path.

No Task 12 files were changed. No commit was created; coordinator review is pending.

## TDD evidence

Genuine RED failures were observed before each corresponding production slice:

- missing scorer module;
- missing package command;
- missed fast-child exit during post-spawn instrumentation;
- hostname and URL redaction gaps;
- leaked global provider/plugin/MCP configuration;
- cancellation incorrectly resolving after cleanup;
- failed `capability_enable` counted as activation;
- fixture capability resolution using the parent Git root;
- missing provider-visible schema summarizer;
- capability event names destroyed by hostname redaction;
- missing per-case version metadata.

The final focused suite passes `14` tests with `46` assertions. It includes injected-failure and cancellation cleanup tests that launch a child plus descendant and independently confirm both PIDs are gone.

## Verification

From `packages/opencode`:

- `bun test test/capability/eval.test.ts` — 14 passed, 0 failed, 46 assertions.
- `bun test --timeout 30000 test/capability` — 29 passed, 0 failed, 140 assertions across the full affected capability area. (An earlier concurrent run used Bun's 5-second default and timed out in two pre-existing integration tests; the isolated package-standard timeout run passed.)
- `bun typecheck` — passed.
- `bun run eval:capability --dry-run --baseline --candidate --case missing-capability-recognition --output <temporary>` — passed; suite 1, both arms, exact four management tools.
- `bunx prettier --check eval/capability test/capability/eval.test.ts package.json` — passed.
- `bunx oxlint packages/opencode/eval/capability packages/opencode/test/capability/eval.test.ts` — 0 errors; 10 type-safety/style warnings remain in eval parsing/redaction and Bun assertion typing.
- repository `git diff --check` — passed.

Real Qwen gate ran under `/usr/bin/screen`, against `runpod-qwen/qwen3.8-27b`, through the actual OpenCode CLI and configured provider path. The sanitized result is in `live/slice-5/result.md`. Baseline verified 1/3 criteria and candidate verified 3/3, so completion improved from 0% to 100% and passed the 1% threshold. Candidate trace was exactly `capability_search` → `capability_enable` → `eval-proof_writer_write_proof`; the artifact content was independently checked. Provider-visible capability schemas grew from exactly four management definitions to those four plus one proof definition, 1,621 to 1,890 bytes (406 to 473 estimated tokens).

No `screen` socket, eval runner, OpenCode child, or proof MCP descendant remained after the gate.

## Self-review

- Process lifecycle: every external child is detached into its own process group; cleanup signals only the negative owned PGID, escalates TERM to KILL, and runs on success, child failure, abort, signal interruption, fast exit, and injected post-spawn failure.
- Privacy: tracked reports are a strict allowlist of normalized metrics/evidence; raw traces are opt-in and ignored. Recursive redaction covers authorization/API-key fields, bearer material, credential URLs, hostnames, home paths, and session identifiers while preserving a finite allowlist of capability event types.
- Reproducibility: suite and every case have explicit version 1; both arms use the same selected provider, Qwen model, prompt, repository fixture, temperature, reasoning setting, context declaration, and isolated environment. The sole intended difference is capability-tool visibility.
- Evidence validity: assistant completion text is ignored. The live pass requires exact artifact bytes plus completed activation evidence and no unnecessary activation.
- Scorer gaming: a failed tool call, unrelated activation, or larger-than-required profile is penalized; a candidate must strictly improve full-case externally verified completion and stay within the four-management-tool budget.
- Schema accounting: an in-memory loopback observes the actual provider request schema snapshots without persisting request bodies, excludes title/non-task calls and ordinary tools, and compares provider-visible capability definitions on a like-for-like basis.

## Known metadata limitation

The live serving stack did not expose a server commit. The runner supports `QWEN_EVAL_SERVER_COMMIT`; the sanitized live result records that this infrastructure-supplied field was unavailable rather than inventing a revision. Model ID, quantization, OpenCode commit, suite/case versions, seed support, and settings are recorded.
