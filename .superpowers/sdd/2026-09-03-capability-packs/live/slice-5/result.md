# Slice 5 — Qwen capability A/B

- Model: `runpod-qwen/qwen3.8-27b`
- Quantization: `UD-IQ2_XXS`
- Suite/case: `1` / `missing-capability-recognition@1`
- OpenCode base: `efa7e7e80c992605373c17836811adeef59a09d1`
- Acceptance: **PASS** (`0%` baseline versus `100%` candidate verified completion; required gain `1%`)

| Arm | Verified | Tool trace | Provider input | Raw prefill | Assistant output | First useful | Wall | Capability schemas |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Baseline | 1/3 | none | 8,227 | 8,227 | 857 | n/a | 21,345 ms | 0→0, 2 B→2 B, 1→1 estimated tokens |
| Candidate | 3/3 | search → enable → proof writer | 44,342 | 8,762 | 422 | 11,850 ms | 20,563 ms | 4→5, 1,621 B→1,890 B, 406→473 estimated tokens |

External verification confirmed exact artifact content, exact `eval-proof/default` activation, and no unrelated activation. The candidate made no failed or incorrect tool calls. The baseline created no artifact and made no tool calls. The provider endpoint, credentials, raw prompt, session IDs, timestamps, and temporary paths are omitted. Raw traces remain ignored locally.

The serving-stack commit was not exposed to the runner; supply `QWEN_EVAL_SERVER_COMMIT` in infrastructure-owned runs to replace the suite placeholder.
