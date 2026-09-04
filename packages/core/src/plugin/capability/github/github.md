---
name: github-workflows
description: Inspect GitHub state with structured read-only gh commands before considering mutations.
---

# GitHub workflows

Use the built-in `bash` tool with `gh --json` and `--jq` where supported. Start read-only and infer no remote state from the local Git checkout alone.

1. Confirm the repository identity and authentication status without printing tokens.
2. Prefer structured fields for repository, issue, pull-request, workflow, run, and release inspection.
3. Keep write operations separate and let the existing `bash` permission boundary authorize the exact command string.
4. Preserve large structured responses through the existing session tool-output artifact store and cite returned artifact paths.
5. Re-query the decisive remote state after any authorized mutation; a successful command exit is not proof of the requested outcome.

Never put tokens in command arguments, reports, or artifacts. Use the credential store or inherited environment only.
