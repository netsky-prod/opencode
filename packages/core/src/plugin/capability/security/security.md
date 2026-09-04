---
name: security-testing
description: Run scoped static or dynamic security checks and preserve evidence-backed findings.
---

# Security testing

Confirm the authorized target and choose the smallest profile: `security/static` for local source and dependency analysis, or `security/dynamic` for an explicitly authorized running target.

1. Use the built-in `bash` tool for all scanner invocations. Its canonical permission action is `bash`, and the exact command string is the permission resource; never bypass or broaden that decision.
2. Seed or identify deterministic validation cases before scanning, then run only tools relevant to the requested threat model.
3. Preserve machine-readable output where supported. Large output flows through the existing session tool-output artifact store; cite each returned artifact path and the exact command that produced it.
4. Reproduce each material finding with a focused check. Label unconfirmed scanner matches as leads, not vulnerabilities.
5. Record scope, tool version, target, evidence, severity rationale, false-positive analysis, and remediation.

Never place credentials in command strings or artifacts. Do not probe third-party or production targets unless the task explicitly authorizes that exact scope.
