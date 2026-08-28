# OpenCode Fork Release and Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the loop-enabled `netsky-prod/opencode` fork installable and safely upgradeable on macOS and Linux from its own GitHub releases.

**Architecture:** Centralize fork release URLs in the TypeScript installation service, point the shell installer at `netsky-prod/opencode`, and add a minimal manual GitHub Actions workflow that creates unsigned CLI archives with the existing Bun build. Keep upstream's publisher untouched because it depends on private runners, signing infrastructure, npm publication, and desktop release jobs.

**Tech Stack:** Bash, TypeScript, Bun, GitHub Actions, GitHub CLI, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-28-opencode-loop-design.md`

## Global Constraints

- The binary and command remain named `opencode`.
- The installer source is `https://raw.githubusercontent.com/netsky-prod/opencode/dev/install`.
- Release metadata and archives come only from `netsky-prod/opencode`.
- A curl-installed fork must never upgrade itself from `anomalyco/opencode`.
- First release scope is unsigned CLI archives for Darwin arm64/x64 and Linux arm64/x64.
- Do not publish npm, Homebrew, Scoop, Chocolatey, desktop, or signed Windows artifacts.
- Do not modify upstream `.github/workflows/publish.yml`.
- Release creation is manual and accepts an explicit prerelease semver such as `1.18.25-loop.1`.

---

## File map

- `packages/opencode/src/installation/source.ts` — canonical fork repository and installer URLs.
- `packages/opencode/src/installation/index.ts` — latest-version and curl-upgrade source.
- `packages/opencode/test/installation/installation.test.ts` — request URL and installer execution tests.
- `install` — fork release download source and replacement notice.
- `packages/opencode/test/installation/install-script.test.ts` — local-binary installer smoke test and source assertions.
- `.github/workflows/fork-release.yml` — manual fork CLI release.
- `packages/opencode/test/installation/fork-release-workflow.test.ts` — workflow contract.
- `docs/fork-release.md` — installation, Gatekeeper, release, and upstream-sync runbook.
- `README.md` — fork install command.

### Task 1: Canonical fork release source and safe curl upgrades

**Files:**

- Create: `packages/opencode/src/installation/source.ts`
- Modify: `packages/opencode/src/installation/index.ts`
- Modify: `packages/opencode/test/installation/installation.test.ts`

**Interfaces:**

- Consumes existing `Installation.Service`.
- Produces:

```ts
export const FORK_REPOSITORY = "netsky-prod/opencode"
export const FORK_RELEASE_API = "https://api.github.com/repos/netsky-prod/opencode/releases/latest"
export const FORK_INSTALLER = "https://raw.githubusercontent.com/netsky-prod/opencode/dev/install"
```

- [ ] **Step 1: Write failing URL tests**

Capture requests in the existing mock HTTP client:

```ts
testEffect(
  testLayer((request) => {
    calls.push(request.url)
    if (request.url.endsWith("/install")) return new Response("install script", { status: 200 })
    return jsonResponse({ tag_name: "v1.18.25-loop.1" })
  }),
).effect("keeps release lookup and curl upgrades on the fork", () =>
  Effect.gen(function* () {
    expect(yield* Installation.use.latest("curl")).toBe("1.18.25-loop.1")
    yield* Installation.use.upgrade("curl", "1.18.25-loop.1")
    expect(calls).toContain("https://api.github.com/repos/netsky-prod/opencode/releases/latest")
    expect(calls).toContain("https://raw.githubusercontent.com/netsky-prod/opencode/dev/install")
    expect(calls.some((url) => url.includes("anomalyco/opencode"))).toBe(false)
  }),
)
```

The fake spawner returns bash version text and successful installer execution.

- [ ] **Step 2: Run RED**

From `packages/opencode`:

```bash
bun test test/installation/installation.test.ts --timeout 30000 --only-failures
```

Expected: request assertions fail on upstream URLs.

- [ ] **Step 3: Add source constants and use them**

Create `source.ts` with the three constants above. Import `FORK_RELEASE_API` and `FORK_INSTALLER` in `installation/index.ts`. Replace only:

```ts
HttpClientRequest.get(FORK_INSTALLER)
HttpClientRequest.get(FORK_RELEASE_API)
```

Leave npm/brew/scoop/choco code unchanged; the supported fork path is curl.

- [ ] **Step 4: Run GREEN**

Run: `bun test test/installation/installation.test.ts --timeout 30000 --only-failures`

Expected: all installation tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/installation/source.ts packages/opencode/src/installation/index.ts packages/opencode/test/installation/installation.test.ts
git commit -m "fix(opencode): keep curl upgrades on fork"
```

### Task 2: Fork-aware shell installer

**Files:**

- Modify: `install`
- Create: `packages/opencode/test/installation/install-script.test.ts`

**Interfaces:**

- Consumes GitHub release archive naming from `packages/opencode/script/build.ts`.
- Produces installer downloads from `netsky-prod/opencode` and local `--binary` smoke-test coverage.

- [ ] **Step 1: Write failing installer tests**

```ts
import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { tmpdir } from "../fixture/fixture"

describe("fork install script", () => {
  test("contains only fork GitHub release endpoints", async () => {
    const script = await Bun.file(path.resolve(import.meta.dir, "../../../../install")).text()
    expect(script).toContain("github.com/netsky-prod/opencode/releases")
    expect(script).toContain("api.github.com/repos/netsky-prod/opencode/releases/latest")
    expect(script).not.toContain("github.com/anomalyco/opencode/releases")
  })

  test("installs a supplied binary into an isolated HOME", async () => {
    await using dir = await tmpdir()
    const binary = path.join(dir.path, "fixture-opencode")
    await Bun.write(binary, "#!/bin/sh\necho fork\n")
    await $`chmod +x ${binary}`
    await $`HOME=${dir.path} bash ../../../../install --binary ${binary} --no-modify-path`.cwd(import.meta.dir)
    expect(await Bun.file(path.join(dir.path, ".opencode/bin/opencode")).exists()).toBe(true)
  })
})
```

- [ ] **Step 2: Run RED**

Run: `bun test test/installation/install-script.test.ts --timeout 30000 --only-failures`

Expected: endpoint assertion fails.

- [ ] **Step 3: Change installer repository variables**

At the top:

```bash
APP=opencode
REPOSITORY=netsky-prod/opencode
```

Use `$REPOSITORY` for latest API, release archive, tag existence, and available-releases URLs:

```bash
url="https://github.com/$REPOSITORY/releases/latest/download/$filename"
specific_version=$(curl -s "https://api.github.com/repos/$REPOSITORY/releases/latest" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')
```

Update installer help examples to the raw fork URL. Before copying, if `command -v opencode` resolves inside `$HOME/.opencode/bin` and version differs, print a one-line replacement notice.

- [ ] **Step 4: Run GREEN and shell syntax check**

```bash
bun test test/installation/install-script.test.ts --timeout 30000 --only-failures
bash -n ../../install
```

Run from `packages/opencode`. Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add install packages/opencode/test/installation/install-script.test.ts
git commit -m "feat: point installer at fork releases"
```

### Task 3: Manual GitHub CLI release workflow

**Files:**

- Create: `.github/workflows/fork-release.yml`
- Create: `packages/opencode/test/installation/fork-release-workflow.test.ts`

**Interfaces:**

- Consumes `packages/opencode/script/build.ts` and archive names `opencode-darwin-*` / `opencode-linux-*`.
- Produces a manual draft-then-publish GitHub release.

- [ ] **Step 1: Write the failing workflow contract test**

```ts
import { describe, expect, test } from "bun:test"
import path from "path"

describe("fork release workflow", () => {
  test("is manual, fork-scoped, unsigned, and verifies required archives", async () => {
    const workflow = await Bun.file(
      path.resolve(import.meta.dir, "../../../../.github/workflows/fork-release.yml"),
    ).text()
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("github.repository == 'netsky-prod/opencode'")
    expect(workflow).toContain("OPENCODE_VERSION:")
    expect(workflow).toContain("gh release upload")
    for (const asset of [
      "opencode-darwin-arm64.zip",
      "opencode-darwin-x64.zip",
      "opencode-linux-arm64.tar.gz",
      "opencode-linux-x64.tar.gz",
    ])
      expect(workflow).toContain(asset)
    for (const forbidden of ["OPENCODE_RELEASE: 1", "npm publish", "blacksmith-", "azure/login", "build-electron"])
      expect(workflow).not.toContain(forbidden)
  })
})
```

- [ ] **Step 2: Run RED**

Run: `bun test test/installation/fork-release-workflow.test.ts --timeout 30000 --only-failures`

Expected: FAIL because the workflow is absent.

- [ ] **Step 3: Create the workflow**

Use this job skeleton:

```yaml
name: fork-release

on:
  workflow_dispatch:
    inputs:
      version:
        description: "Prerelease semver, for example 1.18.25-loop.1"
        required: true
        type: string

permissions:
  contents: write

concurrency:
  group: fork-release-${{ inputs.version }}
  cancel-in-progress: false

jobs:
  cli:
    if: github.repository == 'netsky-prod/opencode'
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ github.token }}
      GH_REPO: ${{ github.repository }}
      OPENCODE_VERSION: ${{ inputs.version }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.14"
      - run: bun install --frozen-lockfile
      - name: Validate version
        run: |
          [[ "$OPENCODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-loop\.[0-9]+$ ]] ||
            { echo "version must match X.Y.Z-loop.N"; exit 1; }
      - name: Create draft
        run: gh release create "v$OPENCODE_VERSION" --draft --prerelease --target "$GITHUB_SHA" --title "v$OPENCODE_VERSION"
      - name: Build CLI
        run: bun packages/opencode/script/build.ts
      - name: Package supported archives
        working-directory: packages/opencode
        run: |
          (cd dist/opencode-darwin-arm64/bin && zip -r ../../opencode-darwin-arm64.zip opencode)
          (cd dist/opencode-darwin-x64/bin && zip -r ../../opencode-darwin-x64.zip opencode)
          tar -C dist/opencode-linux-arm64/bin -czf dist/opencode-linux-arm64.tar.gz opencode
          tar -C dist/opencode-linux-x64/bin -czf dist/opencode-linux-x64.tar.gz opencode
      - name: Upload supported archives
        run: |
          gh release upload "v$OPENCODE_VERSION" \
            packages/opencode/dist/opencode-darwin-arm64.zip \
            packages/opencode/dist/opencode-darwin-x64.zip \
            packages/opencode/dist/opencode-linux-arm64.tar.gz \
            packages/opencode/dist/opencode-linux-x64.tar.gz
      - name: Verify required assets
        run: |
          assets=$(gh release view "v$OPENCODE_VERSION" --json assets --jq '.assets[].name')
          for required in opencode-darwin-arm64.zip opencode-darwin-x64.zip opencode-linux-arm64.tar.gz opencode-linux-x64.tar.gz; do
            grep -qx "$required" <<<"$assets" || { echo "missing $required"; exit 1; }
          done
      - name: Publish
        run: gh release edit "v$OPENCODE_VERSION" --draft=false --prerelease
```

Pin action SHAs during implementation, following existing workflow style. The semantic content above remains unchanged.

- [ ] **Step 4: Run GREEN and parse YAML**

```bash
bun test test/installation/fork-release-workflow.test.ts --timeout 30000 --only-failures
ruby -e 'require "yaml"; YAML.load_file("../../.github/workflows/fork-release.yml", aliases: true); puts "valid"'
```

Run from `packages/opencode`. Expected: test passes and Ruby prints `valid`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/fork-release.yml packages/opencode/test/installation/fork-release-workflow.test.ts
git commit -m "ci: add fork CLI release workflow"
```

### Task 4: Fork runbook and end-to-end release checks

**Files:**

- Create: `docs/fork-release.md`
- Modify: `README.md`

**Interfaces:**

- Consumes completed installer/workflow.
- Produces an operator runbook and final release-slice verification.

- [ ] **Step 1: Write the runbook**

Document these exact commands:

```bash
curl -fsSL https://raw.githubusercontent.com/netsky-prod/opencode/dev/install | bash
opencode --version

git fetch upstream
git switch dev
git merge --ff-only upstream/dev
git push origin dev

gh workflow run fork-release.yml -f version=1.18.25-loop.1
gh run watch
gh release view v1.18.25-loop.1
```

State that releases are unsigned CLI binaries, macOS may require explicit Gatekeeper approval, the installer replaces `~/.opencode/bin/opencode`, and npm/brew installs remain upstream.

Add the fork install command and links to `docs/loop.md` and `docs/fork-release.md` near the README usage section.

- [ ] **Step 2: Run focused verification**

From `packages/opencode`:

```bash
bun test test/installation/installation.test.ts test/installation/install-script.test.ts test/installation/fork-release-workflow.test.ts --timeout 30000 --only-failures
bun run typecheck
bash -n ../../install
```

Expected: every command exits 0.

- [ ] **Step 3: Build the native binary**

From `packages/opencode`:

```bash
OPENCODE_VERSION=1.18.25-loop.0 bun run script/build.ts --single
./dist/opencode-darwin-arm64/bin/opencode --version
```

On this Apple Silicon Mac, expected version output is `1.18.25-loop.0`. If the generated target follows `process.arch` under another executor, use that native target's binary path.

- [ ] **Step 4: Smoke-test the installer with the built binary**

```bash
release_test_home=$(mktemp -d)
HOME="$release_test_home" bash ../../install --binary ./dist/opencode-darwin-arm64/bin/opencode --no-modify-path
HOME="$release_test_home" "$release_test_home/.opencode/bin/opencode" --version
```

Expected: the isolated installed binary prints `1.18.25-loop.0`. Remove only the exact `$release_test_home` directory after validating its non-empty `/.opencode/bin/opencode` path.

- [ ] **Step 5: Commit**

```bash
git add docs/fork-release.md README.md
git commit -m "docs: add fork installation runbook"
```

- [ ] **Step 6: Verify clean state**

```bash
git status --short --branch
git log --oneline --decorate -8
```

Expected: clean branch with four release-slice commits after the loop-core work.
