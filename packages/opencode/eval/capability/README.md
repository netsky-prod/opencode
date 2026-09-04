# Capability Qwen evaluation

This suite compares the configured Qwen model with capability discovery hidden (`baseline`) and exposed (`candidate`). It is a product-outcome eval: assistant text such as “done” never counts. A case passes only when its versioned external verifiers confirm the required artifacts, tool outcomes, or capability lifecycle events.

## Commands

Run validation without contacting the provider:

```sh
bun run eval:capability --dry-run
```

Run both sides, or select one side/case explicitly:

```sh
bun run eval:capability --baseline --candidate --output ./eval-results
bun run eval:capability --candidate --case missing-capability-recognition --output ./eval-results
```

With neither mode flag, both modes run. `--baseline` and `--candidate` are selection flags, not paths to mutable prior results. `--output` receives deterministic sanitized `comparison.json` and `comparison.md`; raw CLI traces and temporary fixtures remain in an OS temporary directory and are deleted after scoring.

For local diagnosis only, `--raw-output ./ignored-local-directory` retains provider traces, stderr, and capability event streams. The runner checks `git check-ignore` and rejects non-ignored or symlink paths. These local traces can contain private prompts; use sanitized reports for sharing.

The live runner requires `RUNPOD_QWEN_API_KEY`. It uses model `runpod-qwen/qwen3.8-27b`; quantization and server revision can be recorded with `QWEN_EVAL_QUANTIZATION` and `QWEN_EVAL_SERVER_COMMIT`. Credentials and endpoint hosts are neither printed nor persisted. Global MCPs, default plugins, external skills, LSP downloads, and auto-updates are disabled for both arms. The only intentional arm difference is visibility of the four capability-management tools.

## Reproducibility and metrics

`cases.json` versions the prompts, fixtures, criteria, model, context, sampling settings, and acceptance thresholds. Both arms receive the same task text and equivalent fresh fixture contents. Reports record:

- model ID, declared quantization, server revision when response headers expose it, OpenCode revision, source digest and dirty state, suite version, seed support, and effective settings;
- per-run SHA-256 `promptDigest` of the exact submitted text, including shared discovery instructions, so different effective tasks cannot silently share a case version;
- externally verified outcomes and incorrect tool-call count/rate;
- provider input tokens, the first raw prefill separately, and assistant/reasoning output tokens when supplied by the provider;
- time to first completed non-management action and total wall time;
- first/final provider-visible tool names, complete schema bytes, and the documented `ceil(UTF-8 bytes / 4)` estimate. Acceptance compares the actual first snapshots across arms and requires exactly the four additional management tools; unexpected tools fail the check.

The context setting is applied to OpenCode's client-side model limit. It does not resize or prove the remote server's KV cache. Non-null seeds and temperature are sent in task requests; deterministic execution still depends on the provider. `reasoning` controls the CLI trace display. Every arm uses a separate database and project root.

Category fixtures are deterministic runtime integration cases, not benchmarks of general browser/research/code quality. Browser launches pinned Playwright Chromium and captures its rendered page; mobile compiles Swift into an iOS Simulator object on macOS with Xcode. Install Chromium with `bunx playwright install chromium`. Research and document cases use local known source documents, security detects a seeded finding, and deploy starts and stops a disposable HTTP service. Missing host dependencies fail explicitly. The checkpoint verifier reads the saved SQLite record. The final broader acceptance task separately exercises the shipped packs on an unseen task.

There is no task-quality deadline. Each OpenCode child starts in its own process group, and the runner tears down that exact group on success, failure, abort, or interruption. Cleanup escalation is bounded so a broken child cannot strand descendants; it is not used as a model-quality cutoff.

## Acceptance

The candidate is accepted only if its externally verified completion rate is strictly higher than baseline by at least `minimumCompletionGain`, and the default interface remains within `maxDefaultCapabilityTools`. The current budget is exactly these four schemas:

- `capability_search`
- `capability_enable`
- `capability_disable`
- `capability_status`

Latency, provider cost, wrong calls, and per-case evidence remain visible in the report even though they do not override the verified-completion gate. In particular, a research run cannot hide a large retrieval/prefill bill inside a short assistant response.

## Privacy

Tracked reports omit raw prompts, tool arguments, headers, environment variables, local paths, endpoint URLs/hosts, session IDs, timestamps, random event/message IDs, and raw diagnostics. Keep provider traces local and ignored. Only concise evidence references (for example `artifact:proof-artifact`) enter the comparison.
