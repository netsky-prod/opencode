import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { loadSuite, redact, scoreCase, scoreComparison } from "../../eval/capability/score"
import {
  buildEvaluationConfig,
  parseArguments,
  prepareFixture,
  readTraceEvidence,
  runOwnedProcess,
  summarizeProviderSchemas,
  writeReports,
} from "../../eval/capability/run"

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })))
})

describe("capability Qwen evaluation scorer", () => {
  test("does not count a model completion claim without externally verified evidence", () => {
    const definition = {
      id: "artifact-proof",
      version: 1,
      requiredCapabilities: ["documents"],
      criteria: [{ id: "artifact", description: "creates the required artifact" }],
    }
    const claimOnly = scoreCase(definition, {
      finalText: "DONE: I created the artifact",
      verifiedOutcomes: [],
      toolCalls: [],
      activations: [],
    })
    const verified = scoreCase(definition, {
      finalText: "not relevant to scoring",
      verifiedOutcomes: [{ criterion: "artifact", passed: true, evidenceRef: "artifact:result.txt" }],
      toolCalls: [],
      activations: [{ capability: "documents", profiles: ["default"] }],
    })

    expect(claimOnly).toMatchObject({ completed: false, verifiedCriteria: 0 })
    expect(verified).toMatchObject({ completed: true, verifiedCriteria: 1 })
  })

  test("penalizes failed calls, unnecessary activation, and a profile larger than required", () => {
    const result = scoreCase(
      {
        id: "smallest-profile",
        version: 1,
        requiredCapabilities: ["mobile"],
        expectedProfiles: { mobile: ["ios"] },
        criteria: [{ id: "simulator", description: "records simulator state" }],
      },
      {
        verifiedOutcomes: [{ criterion: "simulator", passed: true, evidenceRef: "check:simulator" }],
        toolCalls: [{ name: "mobile_runner", status: "error" }],
        activations: [
          { capability: "mobile", profiles: ["ios", "android"] },
          { capability: "research", profiles: ["default"] },
        ],
      },
    )

    expect(result.incorrectToolCalls).toBe(3)
    expect(result.completed).toBe(true)
  })

  test("accepts only a strict verified completion improvement within the four-tool budget", () => {
    const baseline = [
      { caseID: "one", completed: false, verifiedCriteria: 0, totalCriteria: 1, incorrectToolCalls: 0 },
      { caseID: "two", completed: true, verifiedCriteria: 1, totalCriteria: 1, incorrectToolCalls: 0 },
    ]
    const candidate = baseline.map((result) => ({ ...result, completed: true, verifiedCriteria: 1 }))

    expect(
      scoreComparison({
        baseline,
        candidate,
        thresholds: { minimumCompletionGain: 0.01, maxDefaultCapabilityTools: 4 },
        defaultCapabilityTools: 4,
      }),
    ).toMatchObject({ accepted: true, baselineCompletionRate: 0.5, candidateCompletionRate: 1, completionGain: 0.5 })
    expect(
      scoreComparison({
        baseline: candidate,
        candidate,
        thresholds: { minimumCompletionGain: 0.01, maxDefaultCapabilityTools: 4 },
        defaultCapabilityTools: 4,
      }),
    ).toMatchObject({ accepted: false, completionGain: 0 })
    expect(
      scoreComparison({
        baseline,
        candidate,
        thresholds: { minimumCompletionGain: 0.01, maxDefaultCapabilityTools: 4 },
        defaultCapabilityTools: 5,
      }),
    ).toMatchObject({ accepted: false, schemaBudgetPassed: false })
  })
})

describe("capability Qwen evaluation runner", () => {
  test("measures only provider-visible capability schemas after skipping non-task requests", () => {
    const fn = (name: string) => ({
      type: "function",
      function: { name, description: `${name} description`, parameters: { type: "object" } },
    })
    const snapshots = [
      { messages: [], tools: undefined },
      {
        tools: [
          fn("read"),
          fn("capability_search"),
          fn("capability_enable"),
          fn("capability_disable"),
          fn("capability_status"),
        ],
      },
      {
        tools: [
          fn("read"),
          fn("capability_search"),
          fn("capability_enable"),
          fn("capability_disable"),
          fn("capability_status"),
          fn("eval-proof_writer_write_proof"),
        ],
      },
    ]

    const comparison = summarizeProviderSchemas(snapshots, ["eval-proof"])

    expect(comparison.baselineBytes).toBeGreaterThan(2)
    expect(comparison.activatedBytes).toBeGreaterThan(comparison.baselineBytes)
    expect(comparison.deltaBytes).toBe(comparison.activatedBytes - comparison.baselineBytes)
  })

  test("preserves allowlisted capability event names while redacting actual hostnames", () => {
    expect(redact(["capability.schema.estimated", "internal-node.example.invalid"])).toEqual([
      "capability.schema.estimated",
      "<redacted-host>",
    ])
  })

  test("loads the versioned suite with every required behavior and exactly four management tools", async () => {
    const suite = await loadSuite(path.join(import.meta.dir, "../../eval/capability/cases.json"))
    const coverage = new Set(suite.cases.flatMap((item) => item.coverage ?? []))

    expect(suite.version).toBe(1)
    expect(suite.cases.every((item) => item.version === 1)).toBe(true)
    expect(suite.defaultCapabilityTools).toEqual([
      "capability_disable",
      "capability_enable",
      "capability_search",
      "capability_status",
    ])
    expect([...coverage].sort((left, right) => left.localeCompare(right))).toEqual(
      [
        "browser",
        "checkpoint-evidence",
        "deploy",
        "documents",
        "github",
        "missing-capability-recognition",
        "missing-dependency-recovery",
        "mobile",
        "research",
        "security",
        "smallest-profile-selection",
        "unnecessary-activation",
      ].sort((left, right) => left.localeCompare(right)),
    )
    expect(
      JSON.parse(await Bun.file(path.join(import.meta.dir, "../../package.json")).text()).scripts["eval:capability"],
    ).toBe("bun run eval/capability/run.ts")
  })

  test("parses explicit modes and output without mutating process configuration", () => {
    const before = { ...process.env }
    expect(
      parseArguments([
        "--dry-run",
        "--baseline",
        "--candidate",
        "--output",
        "reports",
        "--raw-output",
        "raw",
        "--case",
        "documents",
      ]),
    ).toEqual({
      dryRun: true,
      modes: ["baseline", "candidate"],
      output: "reports",
      rawOutput: "raw",
      cases: ["documents"],
    })
    expect(process.env).toEqual(before)
  })

  test("builds isolated arms from only the selected provider with one intentional visibility difference", () => {
    const source = {
      model: "runpod-qwen/qwen3.8-27b",
      provider: {
        "runpod-qwen": { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://private.example.invalid/v1" } },
        unrelated: { npm: "unrelated" },
      },
      plugin: ["global-plugin"],
      mcp: { global: { type: "remote", url: "https://global.example.invalid" } },
    }
    const baseline = buildEvaluationConfig(source, "baseline", "file:///event-observer.ts", source.model)
    const candidate = buildEvaluationConfig(source, "candidate", "file:///event-observer.ts", source.model)

    expect(baseline.provider).toEqual({ "runpod-qwen": source.provider["runpod-qwen"] })
    expect(baseline.plugin).toEqual(["file:///event-observer.ts"])
    expect(baseline).not.toHaveProperty("mcp")
    expect(baseline).not.toHaveProperty("unrelated")
    expect({ ...baseline, permission: candidate.permission }).toEqual(candidate)
    expect(baseline.permission).toHaveProperty("capability_*", "deny")
    expect(candidate.permission).not.toHaveProperty("capability_*")
  })

  test("does not treat a failed capability enable call as an activation", () => {
    const evidence = readTraceEvidence([
      {
        type: "tool_use",
        timestamp: 10,
        part: { tool: "capability_enable", state: { status: "error", input: { id: "browser", profile: "default" } } },
      },
      {
        type: "tool_use",
        timestamp: 20,
        part: {
          tool: "capability_enable",
          state: { status: "completed", input: { id: "documents", profile: "default" } },
        },
      },
    ])

    expect(evidence.activations).toEqual([{ capability: "documents", profiles: ["default"] }])
    expect(evidence.toolCalls).toEqual([
      { name: "capability_enable", status: "error" },
      { name: "capability_enable", status: "completed" },
    ])
  })

  test("makes an eval fixture its own repository so project capabilities resolve from that root", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "capability-eval-project-root-"))
    temporary.push(directory)
    await prepareFixture(
      {
        id: "project-capability",
        version: 1,
        fixture: "proof-capability",
        requiredCapabilities: ["eval-proof"],
        criteria: [{ id: "proof", description: "proof" }],
      },
      directory,
    )

    expect(await Bun.file(path.join(directory, ".git", "HEAD")).text()).toContain("refs/heads/")
    expect(
      await Bun.file(path.join(directory, ".opencode", "capabilities", "eval-proof", "capability.json")).exists(),
    ).toBe(true)
  })

  test("kills the exact owned process group when an injected failure interrupts a live child", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "capability-eval-cleanup-"))
    temporary.push(directory)
    const pids = path.join(directory, "pids")
    const script = [`echo $$ > ${JSON.stringify(pids)}`, `sleep 300 & echo $! >> ${JSON.stringify(pids)}`, "wait"].join(
      "; ",
    )

    await expect(
      runOwnedProcess({
        command: "/bin/sh",
        args: ["-c", script],
        cwd: directory,
        environment: {},
        afterSpawn: async () => {
          while (!(await Bun.file(pids).exists())) await Bun.sleep(10)
          throw new Error("injected failure")
        },
      }),
    ).rejects.toThrow("injected failure")

    const owned = (await Bun.file(pids).text()).trim().split("\n").map(Number)
    expect(owned.length).toBe(2)
    expect(owned.every((pid) => !isAlive(pid))).toBe(true)
  })

  test("propagates cancellation after cleaning the exact owned process group", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "capability-eval-abort-"))
    temporary.push(directory)
    const pids = path.join(directory, "pids")
    const abort = new AbortController()
    const script = [`echo $$ > ${JSON.stringify(pids)}`, `sleep 300 & echo $! >> ${JSON.stringify(pids)}`, "wait"].join(
      "; ",
    )

    await expect(
      runOwnedProcess({
        command: "/bin/sh",
        args: ["-c", script],
        cwd: directory,
        environment: {},
        signal: abort.signal,
        afterSpawn: async () => {
          while (!(await Bun.file(pids).exists())) await Bun.sleep(10)
          abort.abort()
        },
      }),
    ).rejects.toThrow("aborted")

    const owned = (await Bun.file(pids).text()).trim().split("\n").map(Number)
    expect(owned.every((pid) => !isAlive(pid))).toBe(true)
  })

  test("observes a child that exits while post-spawn instrumentation is still running", async () => {
    const result = await Promise.race([
      runOwnedProcess({
        command: "/usr/bin/true",
        args: [],
        cwd: import.meta.dir,
        environment: {},
        afterSpawn: () => Bun.sleep(50),
      }),
      Bun.sleep(250).then(() => "missed-exit" as const),
    ])

    expect(result).not.toBe("missed-exit")
    expect(result).toMatchObject({ code: 0 })
  })

  test("writes deterministic sanitized JSON and Markdown without private material", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "capability-eval-report-"))
    temporary.push(directory)
    const report = {
      suiteVersion: 1,
      metadata: {
        modelID: "runpod-qwen/qwen3.8-27b",
        quantization: "UD-IQ2_XXS",
        serverCommit: "server-commit",
        openCodeCommit: "open-code-commit",
        seed: 7,
        settings: { temperature: 0 },
      },
      thresholds: { minimumCompletionGain: 0.01, maxDefaultCapabilityTools: 4 },
      defaultCapabilityTools: 4,
      baseline: [],
      candidate: [],
      comparison: {
        accepted: false,
        baselineCompletionRate: 0,
        candidateCompletionRate: 0,
        completionGain: 0,
        schemaBudgetPassed: true,
        explanation:
          "Candidate must improve verified completion by at least 0.01 and retain no more than four management schemas.",
      },
      diagnostics: [
        "Bearer private-token",
        "https://alice:secret@example.invalid/v1",
        "internal-node.example.invalid",
        "/Users/private/project",
        "sessionID=ses_private",
      ],
      credentials: { token: "raw-token-value", clientSecret: "raw-client-secret", password: "raw-password" },
    }

    await writeReports(directory, report)
    const json = await Bun.file(path.join(directory, "comparison.json")).text()
    const markdown = await Bun.file(path.join(directory, "comparison.md")).text()

    expect(json).not.toContain("private-token")
    expect(json).not.toContain("alice:secret")
    expect(json).not.toContain("internal-node.example.invalid")
    expect(json).not.toContain("/Users/private")
    expect(json).not.toContain("ses_private")
    expect(json).not.toContain("raw-token-value")
    expect(json).not.toContain("raw-client-secret")
    expect(json).not.toContain("raw-password")
    expect(markdown).toContain("Verified completion threshold")
    expect(markdown).toContain("0.01")
  })
})

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
