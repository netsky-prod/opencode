# Task 8 Report: Checkpoint Wake Injection and Compaction Context

## Outcome

Scheduled wakes now present loop identity, mode, reason, fallible checkpoint evidence, artifact paths, next action, the loop prompt, and explicit checkpoint/control instructions in a stable order. Persisted reason and checkpoint strings are JSON encoded inside an explicit untrusted-data boundary, so multiline fake headers remain data instead of becoming privileged wake instructions. Corrupt checkpoints remain isolated.

Every Core provider turn receives fresh Session-ID-scoped loop context unconditionally capped at 8 KiB. The renderer reserves identity, objective, one representative fact/evidence item, one artifact, and next action for each included loop before optional details. It includes at most 80 visible loops and reports the count of any lower-priority omissions. Completed loops are omitted. Paused loops appear only when the actual current turn explicitly names their ID.

No goal entity or parallel state model was added.

## Review Round 1 Fixes

### Fail-closed configuration

An unresolved exact `{env:NAME}` token no longer removes a higher-precedence document and exposes lower-precedence defaults, providers, or policies. Location construction now terminates with `Config.UnresolvedEnvironmentError`; its diagnostic contains only the source path and unresolved-token count. The configuration layer preserves its existing no-recoverable-error contract by raising that typed error as a fatal configuration defect. Resolved values are never logged.

Recursive substitution still covers nested V1 provider options before migration, and arbitrary shell syntax remains untouched.

### Checkpoint data boundary

Wake and ambient renderers JSON encode each selected dynamic scalar. They emit explicit begin/end delimiters and tell the provider that embedded content is untrusted data, not instructions. Tests cover adversarial objectives, facts, evidence, artifacts, reasons, fake headers, and multiline directives. The renderer selects fields rather than duplicating the stored checkpoint JSON.

### Fair 8 KiB allocation

The ambient renderer first assigns a fair per-loop budget and emits one compact essential record for every included visible loop. Only after all essential records exist does it append optional facts, uncertainty, criteria, observations, decisions, and blockers while checking the final delimiter against the byte cap. Six simultaneous maximum-length checkpoints prove that later loops retain all essential markers within 8 KiB.

### Pathological cardinality

The renderer accepts legacy or corrupt high-cardinality state safely by hard-capping provider-visible records at 80. It preserves the deterministic `SessionLoop.list` priority order: active before paused, then earlier next-run time, then loop ID. Bytes for the generated omission-count marker and final delimiter are reserved before per-record allocation. Loop IDs and checkpoint scalars share bounded JSON-encoded budgets, so even unusually long IDs cannot break the cap or the untrusted-data boundary.

### Structural current-turn provenance

Completed compaction events and messages now persist the exact current user-turn text separately from the retained `recent` transcript. The first continuation after compaction consults this field and never scans the whole retained buffer for paused-loop IDs. Existing compactions without the optional field fail closed by exposing no paused loop. Client and SDK types were regenerated for the optional field.

### Provider-boundary evidence

The full-server OpenAI-compatible fixture inserts a distinct non-due companion loop. It asserts that the companion marker reaches an actual provider `system` message and is absent from the scheduled user wake. This gate fails if `SessionLoopContext` injection is removed.

## TDD Record

### RED

- The missing-environment regression completed successfully and exposed lower-priority configuration instead of failing location loading.
- Adversarial scheduler and ambient tests showed raw fake `Loop prompt:`, `System:`, and delimiter lines.
- Six maximum-size checkpoints exhausted the byte budget after three loops.
- A post-compaction provider turn exposed a paused loop solely because its ID appeared in historical retained context.
- The full-server provider capture contained no ambient-only marker.
- A mutation removing automatic current-turn persistence failed the automatic-compaction regression.
- Two hundred active loops with long IDs and long checkpoint fields produced 107,518 bytes instead of the required maximum of 8,192 bytes.

### GREEN

- Focused scheduler/context suite: 16 passed, 0 failed, 117 expectations; Core typecheck passed.
- Broader Core regression suite: 203 passed, 0 failed, 674 expectations.
- Full-server provider capture plus updater regression: 2 passed, 3 unrelated skips, 0 failed.
- OpenCode loop bridge/command regressions: 3 passed, 0 failed; OpenCode typecheck passed.
- Schema, client, and SDK typechecks passed; generated client and SDK contracts contain the optional compaction provenance field.
- Targeted lint completed with 0 errors. Reported warnings are pre-existing long-file/test-fixture warnings.
- The pathological-cardinality regression retains the first 80 priority-ordered records, reports 120 omissions, excludes the first omitted record, and stays within 8,192 bytes.

## Real-Provider Acceptance

A fresh Qwen run created exactly two adaptive loops and scheduled both with no tool errors or goal-tool use. One was a wake probe whose persisted prompt and checkpoint did not contain the companion marker; the other held the marker only in its durable checkpoint.

The session was manually compacted, the server was stopped, only the probe due time was moved into the past, and a new server process resumed it. The persisted scheduled user message remained marker-free. Qwen reported the companion marker, updated the probe checkpoint, rescheduled it, made no `loop_list` call during the wake, and finished without an error. Both loops remained active with zero scheduler failures.

The gate used `/usr/bin/screen` as the tmux-equivalent because tmux was unavailable. A supervising validation wrote the redacted result marker after checking the durable rows and provider turn. The exact process group was terminated afterward; the process table and test port were clear.

## Public Hygiene

Only the concise redacted `live/slice-2/task8-result.json` remains tracked. All live scripts, JSONL traces, stderr files, raw database extracts, and fixture diagnostics were removed from Git tracking but preserved locally under ignored paths.

The unpublished Task 8 history after its Task 7 base was rewritten as one sanitized commit. Every commit and tree in that range was searched for raw diagnostic paths; its changed content was also searched for home-directory paths, private Session IDs, generated loop IDs, and bearer/API-key material. No raw live bundle, personal path, runtime path, private identifier, or secret value remains reachable from the Task 8 branch history.

## Concerns

- Older compaction records do not have `currentTurn`; they intentionally omit paused-loop context until a new current turn explicitly references the loop.
- Detailed live traces remain local for diagnosis and are not public evidence; the tracked result is deliberately limited to fail-closed booleans.
