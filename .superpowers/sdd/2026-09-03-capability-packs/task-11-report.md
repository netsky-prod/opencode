# Task 11 report — Versioned Qwen Evaluation Suite

## Outcome

Implemented the versioned capability evaluation runner, externally verified scoring, deterministic JSON/Markdown reports, strict four-schema acceptance gate, privacy redaction, owned-process cleanup, and a real Qwen baseline/candidate gate through the actual OpenCode CLI/provider path.

Initial implementation was committed as `15e5e0d`. Review rejected nominal outcome cases and gaps in schema gating, privacy, and provenance. The following initial evidence is historical; the fix-round section below supersedes it. Task 12 remains pending.

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

## Review fix round 1

- Replaced activation-only cases with deterministic input fixtures and external artifact/state checks. Browser runs actual Chromium and captures a 640×480 screenshot; mobile runs swiftc against the iOS Simulator SDK and verifies its Mach-O object. The initial worker's static 1×1 PNG and claimed build JSON were rejected and replaced. These are runtime integration fixtures; no claim of general research or coding quality is made.
- Schema accounting retains the first and last complete provider-visible tool snapshots. The gate checks baseline tool names against a closed built-in list, and candidate names must equal baseline plus exactly the four management tools. Extra inactive tools cannot be filtered away.
- Requested temperature/context are applied; optional seed is sent at the forwarding boundary. Reports distinguish client context from unverified server capacity, capture source digest/dirty state, and inspect response headers for server revision. No prompts or bodies are retained in schema snapshots.
- Raw-output destinations must be Git-ignored and not symlinked. Errors are redacted. Structured suite/trace parsing and typed redaction remove unsafe assertions. Scoped lint is clean.
- Missing --case values fail. Each case uses its own SQLite file. Checkpoints require actual completed database records with the known fact and source artifact; deleting the database fails the regression.
- Real Qwen re-evaluation from the committed fix is pending. The old result does not establish acceptance of this revision.

## Review fix round 2

The reviewer accepted the external verifiers, actual schema gate, settings and provenance implementation. Remaining findings were directory-wide raw ignore validation, opaque diagnostics, and meaningful alternative profiles. Raw sinks now require the entire directory to be Git-ignored and reject pre-existing non-regular/symlink files. A finite public error-message list replaces opaque errors with a generic message. Mobile offers ios, android, and all; every activation must match the expected minimal selection.

The first committed-code multi-case run was stopped after the browser baseline made 221 invalid task calls using the literal agent name `...`. This is recorded as an invalid/incomplete evaluation, not accepted or deadline-failed evidence. Both arms now receive the same explicit instruction to report BLOCKED when capability discovery is absent. Cleanup of the owned runner/CLI/screen was confirmed. The rerun is pending.

Focused tests: 23 passed, 117 assertions. This includes actual Chromium rendering, iOS Simulator compilation, checkpoint database existence/state, raw directory ignore regression, opaque diagnostics, alternative profiles, and process cleanup. Typecheck and scoped lint verification follow in the final result.
