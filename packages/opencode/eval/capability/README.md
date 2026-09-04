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

For local diagnosis only, `--raw-output ./ignored-local-directory` retains provider traces, stderr, and capability event streams. They can contain private prompts and machine details, so the directory must remain ignored and must never be committed.

The live runner requires `RUNPOD_QWEN_API_KEY`. It uses model `runpod-qwen/qwen3.8-27b`; quantization and server revision can be recorded with `QWEN_EVAL_QUANTIZATION` and `QWEN_EVAL_SERVER_COMMIT`. Credentials and endpoint hosts are neither printed nor persisted. Global MCPs, default plugins, external skills, LSP downloads, and auto-updates are disabled for both arms. The only intentional arm difference is visibility of the four capability-management tools.

## Reproducibility and metrics

`cases.json` versions the prompts, fixtures, criteria, model, context, sampling settings, and acceptance thresholds. Both arms receive the same task text and equivalent fresh fixture contents. Reports record:

- model ID, quantization, server revision, OpenCode revision, suite version, seed support, and settings;
- externally verified outcomes and incorrect tool-call count/rate;
- provider input tokens, the first raw prefill separately, and assistant/reasoning output tokens when supplied by the provider;
- time to first completed non-management action and total wall time;
- baseline/activated schema bytes and the documented `ceil(UTF-8 bytes / 4)` estimate emitted by capability instrumentation.

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
