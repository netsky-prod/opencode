import fs from "fs/promises"
import path from "path"
import { runOwnedProcess } from "../run"

export async function runFixtureOutcome(caseID: string, root: string) {
  const input = (name: string) => path.join(root, ".eval", "input", name)
  const evidence = (name: string) => path.join(root, ".eval", "evidence", name)
  await fs.mkdir(path.join(root, ".eval", "evidence"), { recursive: true })
  if (caseID === "browser") {
    const { chromium } = await import("@playwright/test")
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
      await page.setContent(await fs.readFile(input("page.html"), "utf8"))
      if ((await page.locator("main").getAttribute("data-state")) !== "ready")
        throw new Error("Fixture UI is not ready")
      await page.screenshot({ path: evidence("browser.png") })
    } finally {
      await browser.close()
    }
    return "Verified ready UI state and captured browser.png"
  }
  if (caseID === "research") {
    const source = await fs.readFile(input("primary-source.txt"), "utf8")
    if (source.split("\n")[0] !== "Capability evals require external evidence.") {
      throw new Error("Primary-source fact is missing")
    }
    await fs.writeFile(
      evidence("research.json"),
      '{"fact":"Capability evals require external evidence.","source":"primary-source.txt#L1"}\n',
      "utf8",
    )
    return "Verified the fixture primary source and wrote a line-addressed citation"
  }
  if (caseID === "mobile") {
    const project: unknown = JSON.parse(await fs.readFile(input("mobile-project.json"), "utf8"))
    if (
      !project ||
      typeof project !== "object" ||
      !("bundle" in project) ||
      !("target" in project) ||
      project.bundle !== "com.example.eval" ||
      project.target !== "ios"
    )
      throw new Error("Mobile build input is invalid")
    if (process.platform !== "darwin") throw new Error("iOS compilation requires macOS and Xcode")
    const sdk = await runOwnedProcess({
      command: "/usr/bin/xcrun",
      args: ["--sdk", "iphonesimulator", "--show-sdk-path"],
      cwd: root,
      environment: process.env,
    })
    if (sdk.code !== 0) throw new Error("iOS Simulator SDK unavailable")
    await fs.writeFile(
      input("Eval.swift"),
      'import Foundation\npublic func evalValue() -> String { "com.example.eval" }\n',
    )
    const build = await runOwnedProcess({
      command: "/usr/bin/xcrun",
      args: [
        "swiftc",
        "-sdk",
        sdk.stdout.trim(),
        "-target",
        `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-ios17.0-simulator`,
        "-emit-object",
        input("Eval.swift"),
        "-o",
        evidence("mobile.o"),
      ],
      cwd: root,
      environment: process.env,
    })
    if (build.code !== 0) throw new Error("iOS Simulator compilation failed")
    await fs.writeFile(evidence("mobile-build.json"), '{"build":"passed","bundle":"com.example.eval"}\n', "utf8")
    return "Validated the iOS build graph and wrote the deterministic build artifact"
  }
  if (caseID === "security") {
    const source = await fs.readFile(input("vulnerable.env"), "utf8")
    const line = source.split("\n").findIndex((value) => value.includes("EVAL-SECRET-001")) + 1
    if (line < 1) throw new Error("Seeded security finding is missing")
    await fs.writeFile(evidence("security.json"), `{"finding":"EVAL-SECRET-001","line":${line}}\n`, "utf8")
    return "Detected the seeded finding and wrote line-addressed evidence"
  }
  if (caseID === "documents") {
    const document = await fs.readFile(input("document.txt"), "utf8")
    const fact = document.split("\n").find((line) => line.startsWith("The verification code is "))
    if (fact !== "The verification code is DOC-742.") throw new Error("Document fact is missing")
    await fs.writeFile(evidence("documents.json"), `{"fact":${JSON.stringify(fact)}}\n`, "utf8")
    return "Extracted the exact document fact"
  }
  if (caseID === "github") {
    const subject = (await fs.readFile(path.join(root, ".git", "COMMIT_EDITMSG"), "utf8")).trim()
    if (subject !== "Initial fixture commit") throw new Error("Fixture commit subject is unexpected")
    const target = path.join(root, ".git", "eval-evidence", "github.json")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, `{"subject":${JSON.stringify(subject)}}\n`, "utf8")
    return "Inspected committed repository metadata without changing the worktree"
  }
  if (caseID === "deploy") {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok\n") })
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`)
      const health = await response.text()
      if (!response.ok || health !== "ok\n") throw new Error("Fixture health check failed")
      await fs.writeFile(evidence("deploy-health.txt"), health, "utf8")
      await fs.writeFile(evidence("deploy-port.txt"), `${server.port}\n`, "utf8")
    } finally {
      await server.stop(true)
    }
    return "Verified health and stopped the disposable service"
  }
  if (caseID === "missing-dependency-recovery") {
    await fs.access(path.join(root, ".eval", "dependency-ready"))
    await fs.writeFile(evidence("dependency-recovery.json"), '{"dependency":"available","retry":"passed"}\n', "utf8")
    return "Verified dependency remediation and successful retry"
  }
  throw new Error(`Unsupported capability eval fixture: ${caseID}`)
}
