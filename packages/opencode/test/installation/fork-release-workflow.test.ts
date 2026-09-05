import { describe, expect, test } from "bun:test"
import path from "path"

describe("fork release workflow", () => {
  test("is manual, fork-scoped, unsigned, and verifies required archives", async () => {
    const workflow = await Bun.file(
      path.resolve(import.meta.dir, "../../../../.github/workflows/fork-release.yml"),
    ).text()
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("github.repository == 'netsky-prod/netsky-code'")
    expect(workflow).toContain("OPENCODE_VERSION:")
    expect(workflow).toContain("gh release upload")
    for (const asset of [
      "netsky-darwin-arm64.zip",
      "netsky-darwin-x64.zip",
      "netsky-linux-arm64.tar.gz",
      "netsky-linux-x64.tar.gz",
      "release.json",
      "SHA256SUMS",
    ]) {
      expect(workflow).toContain(asset)
    }
    for (const forbidden of ["OPENCODE_RELEASE: 1", "npm publish", "blacksmith-", "azure/login", "build-electron"]) {
      expect(workflow).not.toContain(forbidden)
    }
  })
})
