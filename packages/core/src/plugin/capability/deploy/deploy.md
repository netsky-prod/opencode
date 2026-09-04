---
name: deployment-verification
description: Build or deploy only within explicit scope, verify health externally, and clean disposable resources.
---

# Deployment verification

Choose only the required profile: `deploy/core`, `deploy/runpod`, or `deploy/cloudflare`. A missing CLI or unavailable daemon is a degraded profile with actionable remediation, not permission to launch desktop software or install dependencies.

1. Use the built-in `bash` tool for Docker, runpodctl, and Wrangler. The canonical permission action is `bash`; the exact command string remains the resource for each decision.
2. Inspect current state before mutation. Identify the exact project, account, region, service, image, network, container, and port in scope.
3. Prefer disposable names and reversible changes. Never infer authority to publish, push, deploy, delete, or incur provider cost from pack activation.
4. Preserve builds, logs, inspect output, and health responses through the existing session tool-output artifact store; cite returned paths for large output.
5. Verify the service from outside its process, then remove only disposable resources created for the task and prove no owned process, listener, container, image, or network remains.

Credentials stay in the provider credential store or inherited environment. Never embed, echo, or persist them in commands, manifests, logs, or artifacts.
