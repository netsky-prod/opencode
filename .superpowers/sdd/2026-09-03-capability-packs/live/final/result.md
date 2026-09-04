# Final capability acceptance

The runtime at `41d54906dbf9c1d58e2ef2f3a741812281fa9332` passed final native acceptance on 2026-09-05 (Europe/Moscow). The exact tested binary is installed locally. Source integration is recorded separately in the release report; this is not a newly published binary release.

## Provenance and protocol

- Clean runtime revision: `41d54906dbf9c1d58e2ef2f3a741812281fa9332`.
- Native version: `0.0.0-local-202609042243`, built with `OPENCODE_CHANNEL=local bun run build --single --skip-install`, including the embedded Web UI.
- Binary SHA-256: `79a9310d0c46c5a322834a9083f805f6a2fcf743aac5881f0c1c2b19a74a41a0`.
- Model alias: `runpod-qwen/qwen3.8-27b`, reported quantization `UD-IQ2_XXS`, temperature 0. No seed requested; server commit unavailable.
- Identical prompt SHA-256: `618d19656c542f413cdb4092a7900f41c4f7e5667edbe86945fb1176f0df22f1`.
- Real native CLI sessions under macOS `screen` because tmux was unavailable; no quality deadline. Separate workspaces, database/config/home/cache per arm; global plugins/MCP and bash disabled in both. Capability management denied only in baseline. The local verifier served the requested project in both arms.
- Task: research browser storage, build an offline Follow-up Desk, verify actual behavior, preserve a durable completion checkpoint, and release activated packs. This is an integration scenario, not a representative benchmark of model intelligence.

## Independently checked outcome

| Criterion                                               | Baseline | Capability packs |
| ------------------------------------------------------- | -------- | ---------------- |
| Research report with primary-source URLs                | Pass     | Pass             |
| Actual agent-generated browser screenshot               | Missing  | Pass             |
| Successful research MCP call                            | Absent   | Pass             |
| Successful browser tool call                            | Absent   | Pass             |
| Completed checkpoint with existing deliverable evidence | Pass     | Pass             |
| Reject invalid email                                    | Pass     | Pass             |
| Add record                                              | Pass     | Pass             |
| Persist through reload                                  | Pass     | Pass             |
| Reject case-insensitive duplicate                       | Pass     | Pass             |
| Complete/reopen action changes record                   | Pass     | Pass             |
| Mobile layout has no horizontal overflow                | Pass     | Pass             |
| **Total**                                               | **8/11** | **11/11**        |

Both processes exited 0. Wall time: baseline 432,391 ms (7m12s), candidate 638,550 ms (10m39s). Candidate did more verification work and was not faster. Both applications passed all six external functional UI checks in independent Chromium sessions at 390×844. Both independent screenshots and the candidate's own screenshot were visually inspected. No external requests were observed during the verifier's UI flow.

Both sessions retained one legacy conversation, zero Core transcript messages, one acknowledged loop input, zero pending loop inputs, a completed loop, and zero remaining capability activations. The candidate actually enabled research/browser, searched via Federated Research MCP, fetched primary pages, interacted with the page, saved a screenshot, and disabled both packs. It made recoverable tool errors; the full ordered, sanitized tool/status traces and deliverable hashes are in [result.json](./result.json).

The scores deliberately include three tool/evidence criteria unavailable in baseline. Thus the result demonstrates working integration and autonomous use of added capabilities, **not** that the candidate's generated application was functionally better. Browser-enabled candidate behavior is not a full accessibility, security, production-readiness, or factual-accuracy audit.

## Scorer correction and excluded runs

The first strict checkpoint scorer gave baseline 7/11 because its `artifacts` array was empty. Its verified facts nevertheless referenced existing `index.html` and `research.md`, which met the actual evidence requirement. The corrected scorer accepts an existing, closed-list deliverable reference in either `artifacts` or `verifiedFacts.evidence`, applies the same rule to both arms, and rejects wrong-arm, missing-file and suffix matches. Its two regression tests passed eight assertions. Original 7/11 output remains preserved locally; the final symmetric result is 8/11 versus 11/11.

The older native attempt exposed split legacy/Core histories and was invalidated, stopped, and preserved with its database and overwritten report. It is not counted as acceptance. Earlier Task 11 evidence remains separate: the historical five-case run had a recovery false negative; the corrected clean proof/recovery rerun at `d15cd7f` was 0/2 baseline versus 2/2 candidate. None of these results is silently substituted for another.

## Source audit limitations

Both arms fetched real primary pages before writing their implementation. Candidate's attempted old Chrome blog URL returned 404 and it fetched the replacement documentation. However, the report calls redirecting publisher aliases canonical URLs, and one tracker-retention summary omits the qualification that the interval concerns days of browser use. These are retained model-output imperfections, not manually repaired evidence. Report-presence scoring must not be read as perfect factual accuracy. The report's CRM recommendations are design analysis, not a compliance audit.

## Regression and distribution evidence

- Core: 1,243 tests passed, zero failures, 3,573 assertions across 157 files.
- OpenCode: all 260 test files passed in the complete isolated-process sweep; no file filtering. This is not a claim about a single shared-process `bun test` invocation.
- Schema: 15 tests passed. Core/OpenCode/schema/SDK/client typechecks and migration check passed.
- Native build, compiled asset probe, public schema/SDK regressions, and eval dry-run passed. Scoped lint: zero errors, 40 warnings, including existing warnings.
- Independent final runtime review: no Critical or Important findings.
- Installed binary hash equals the tested binary. The old binary, shell config, and OpenCode config backups are retained. Original global MCPs and skills are preserved; no opt-in migration was silently performed.

Raw transcripts, databases, screenshots, verifier outputs, and process logs remain in ignored local `native-r2/` evidence. Public evidence contains tool names/statuses and hashes, not prompts with private paths, reasoning traces, endpoint credentials, or session identifiers. Later evidence-only commits do not alter the tested runtime revision.

The next milestone is [peer swarm](../../../../../docs/swarm-next.md); it is not implemented or included in this acceptance.
