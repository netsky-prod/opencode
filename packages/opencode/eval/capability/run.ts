import { spawn } from "node:child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { CapabilityTokenEstimate } from "@opencode-ai/core/capability/token-estimate"
import type { ToolDefinition } from "@opencode-ai/llm"
import { loadSuite, redact, scoreCase, scoreComparison, type CaseDefinition, type CaseScore, type Suite } from "./score"

export type Mode = "baseline" | "candidate"

export type Arguments = {
  readonly dryRun: boolean
  readonly modes: ReadonlyArray<Mode>
  readonly output: string
  readonly rawOutput?: string
  readonly cases: ReadonlyArray<string>
}

export type OwnedProcessInput = {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly stdin?: string
  readonly signal?: AbortSignal
  readonly afterSpawn?: (pid: number) => Promise<void>
}

export type Trace = {
  readonly type?: string
  readonly timestamp?: number
  readonly part?: {
    readonly type?: string
    readonly tool?: string
    readonly text?: string
    readonly state?: { readonly status?: string; readonly input?: unknown }
    readonly tokens?: {
      readonly input?: number
      readonly output?: number
      readonly reasoning?: number
      readonly cache?: { readonly read?: number; readonly write?: number }
    }
  }
}

type CapabilityEvent = { readonly type: string; readonly data?: Record<string, unknown> }

type EvaluatedRun = CaseScore & {
  readonly caseVersion: number
  readonly mode: Mode
  readonly verifiedOutcomes: ReadonlyArray<{
    readonly criterion: string
    readonly passed: boolean
    readonly evidenceRef: string
  }>
  readonly toolTrace: ReadonlyArray<{ readonly name: string; readonly status: "completed" | "error" }>
  readonly capabilityEvents: ReadonlyArray<string>
  readonly incorrectToolCallRate: number
  readonly providerInputTokens: number | null
  readonly rawPrefillTokens: number | null
  readonly assistantOutputTokens: number | null
  readonly timeToFirstUsefulActionMs: number | null
  readonly wallTimeMs: number
  readonly capabilitySchemaCost: {
    readonly baselineBytes: number
    readonly baselineTokens: number
    readonly activatedBytes: number
    readonly activatedTokens: number
    readonly deltaBytes: number
    readonly deltaTokens: number
  } | null
}

type Report = {
  readonly suiteVersion: number
  readonly metadata: {
    readonly modelID: string
    readonly quantization: string
    readonly serverCommit: string
    readonly openCodeCommit: string
    readonly seed: number | null
    readonly settings: Readonly<Record<string, string | number | boolean | null>>
  }
  readonly thresholds: Suite["thresholds"]
  readonly defaultCapabilityTools: number
  readonly baseline: ReadonlyArray<EvaluatedRun>
  readonly candidate: ReadonlyArray<EvaluatedRun>
  readonly comparison: ReturnType<typeof scoreComparison>
}

type ProviderConfig = {
  readonly model?: string
  readonly provider?: Readonly<Record<string, unknown>>
}

type SchemaObserver = {
  readonly config: ProviderConfig
  readonly comparison: () => NonNullable<EvaluatedRun["capabilitySchemaCost"]>
  readonly stop: () => void
}

const managementTools = new Set(["capability_disable", "capability_enable", "capability_search", "capability_status"])

export function buildEvaluationConfig(source: ProviderConfig, mode: Mode, observer: string, modelID: string) {
  const providerID = modelID.split("/")[0]
  const provider = source.provider?.[providerID]
  if (!provider) throw new Error(`Configured provider is missing: ${providerID}`)
  const permission = {
    bash: "deny",
    edit: "deny",
    write: "deny",
    patch: "deny",
    ...(mode === "baseline" ? { "capability_*": "deny" } : {}),
  }
  return {
    model: modelID,
    provider: { [providerID]: provider },
    plugin: [observer],
    agent: { build: { temperature: 0 } },
    permission,
  }
}

export function readTraceEvidence(trace: ReadonlyArray<Trace>) {
  const toolCalls = trace.flatMap((item) => {
    if (item.type !== "tool_use" || !item.part?.tool) return []
    return [
      {
        name: item.part.tool,
        status: item.part.state?.status === "completed" ? ("completed" as const) : ("error" as const),
      },
    ]
  })
  const activations = trace.flatMap((item) => {
    if (item.type !== "tool_use" || item.part?.tool !== "capability_enable" || item.part.state?.status !== "completed")
      return []
    const input = item.part.state.input
    if (!input || typeof input !== "object") return []
    const capability = "id" in input && typeof input.id === "string" ? input.id : undefined
    if (!capability) return []
    const profile = "profile" in input && typeof input.profile === "string" ? [input.profile] : []
    const profiles =
      "profiles" in input && Array.isArray(input.profiles)
        ? input.profiles.filter((value): value is string => typeof value === "string")
        : profile
    return [{ capability, profiles }]
  })
  return { toolCalls, activations }
}

export function summarizeProviderSchemas(requestBodies: ReadonlyArray<unknown>, capabilityIDs: ReadonlyArray<string>) {
  const snapshots = requestBodies.map((body) => providerCapabilityDefinitions(body, capabilityIDs))
  const taskSnapshots = snapshots.filter((snapshot) =>
    snapshot.some((definition) => managementTools.has(definition.name)),
  )
  const baseline = taskSnapshots[0] ?? []
  const activated = taskSnapshots.at(-1) ?? baseline
  return CapabilityTokenEstimate.compare(baseline, activated)
}

export function parseArguments(argv: ReadonlyArray<string>): Arguments {
  const requested = [
    argv.includes("--baseline") ? ("baseline" as const) : undefined,
    argv.includes("--candidate") ? ("candidate" as const) : undefined,
  ].filter((mode): mode is Mode => mode !== undefined)
  const value = (name: string) => {
    const index = argv.indexOf(name)
    if (index < 0) return undefined
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`)
    return next
  }
  const cases = argv.flatMap((item, index) => (item === "--case" && argv[index + 1] ? [argv[index + 1]] : []))
  const known = new Set(["--dry-run", "--baseline", "--candidate", "--output", "--raw-output", "--case"])
  argv.forEach((item, index) => {
    if (item.startsWith("--") && !known.has(item)) throw new Error(`Unknown option: ${item}`)
    if (!item.startsWith("--") && !["--output", "--raw-output", "--case"].includes(argv[index - 1] ?? ""))
      throw new Error(`Unexpected argument: ${item}`)
  })
  return {
    dryRun: argv.includes("--dry-run"),
    modes: requested.length > 0 ? requested : ["baseline", "candidate"],
    output: value("--output") ?? path.join(import.meta.dir, "reports"),
    rawOutput: value("--raw-output"),
    cases,
  }
}

export async function runOwnedProcess(input: OwnedProcessInput) {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    detached: true,
    env: input.environment,
    stdio: ["pipe", "pipe", "pipe"],
  })
  if (!child.pid) throw new Error(`Failed to start ${input.command}`)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  if (input.stdin !== undefined) child.stdin.end(input.stdin)
  else child.stdin.end()
  const abort = () => void terminateOwnedProcessGroup(child.pid!)
  input.signal?.addEventListener("abort", abort, { once: true })
  const interrupted = ["SIGINT", "SIGTERM", "SIGHUP"] as const
  let interruption: (typeof interrupted)[number] | undefined
  const interrupt = Object.fromEntries(
    interrupted.map((signal) => [
      signal,
      () => {
        interruption = signal
        abort()
      },
    ]),
  ) as Record<(typeof interrupted)[number], () => void>
  interrupted.forEach((signal) => process.once(signal, interrupt[signal]))
  try {
    await input.afterSpawn?.(child.pid)
    const result = await exited
    if (input.signal?.aborted) throw new Error("Owned process aborted")
    if (interruption) throw new Error(`Owned process interrupted by ${interruption}`)
    return { ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }
  } finally {
    input.signal?.removeEventListener("abort", abort)
    interrupted.forEach((signal) => process.removeListener(signal, interrupt[signal]))
    await terminateOwnedProcessGroup(child.pid)
  }
}

export async function writeReports(directory: string, input: unknown) {
  const report = redact(input) as Report
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")
  const rows = [...report.baseline.map((item) => resultRow(item)), ...report.candidate.map((item) => resultRow(item))]
  const markdown = [
    "# Capability Qwen evaluation",
    "",
    "## Verified completion threshold",
    "",
    report.comparison.explanation,
    "",
    `Result: **${report.comparison.accepted ? "PASS" : "FAIL"}**`,
    "",
    `Baseline verified completion: ${formatRate(report.comparison.baselineCompletionRate)}`,
    `Candidate verified completion: ${formatRate(report.comparison.candidateCompletionRate)}`,
    `Verified completion gain: ${formatRate(report.comparison.completionGain)}`,
    `Default capability schemas: ${report.defaultCapabilityTools}/${report.thresholds.maxDefaultCapabilityTools}`,
    "",
    "| Mode | Case | Verified | Wrong calls | Provider input | Raw prefill | Assistant output | First useful action | Wall time | Schema delta |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "Completion is derived only from external checks, artifacts, and lifecycle events; assistant completion claims are ignored.",
    "Research prefill/provider input is reported independently from assistant output.",
    "",
  ].join("\n")
  await fs.writeFile(path.join(directory, "comparison.md"), markdown, "utf8")
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const suite = await loadSuite(path.join(import.meta.dir, "cases.json"))
  const selected = args.cases.length === 0 ? suite.cases : suite.cases.filter((item) => args.cases.includes(item.id))
  if (selected.length !== (args.cases.length || suite.cases.length))
    throw new Error("One or more requested eval cases do not exist")
  if (args.dryRun) {
    process.stdout.write(
      `${JSON.stringify({ version: suite.version, cases: selected.map((item) => item.id), modes: args.modes, defaultCapabilityTools: suite.defaultCapabilityTools })}\n`,
    )
    return
  }
  if (!process.env.RUNPOD_QWEN_API_KEY) throw new Error("RUNPOD_QWEN_API_KEY is required")
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-capability-eval-"))
  try {
    const runs = await selected.reduce<Promise<EvaluatedRun[]>>(async (pending, definition) => {
      const previous = await pending
      const next = await args.modes.reduce<Promise<EvaluatedRun[]>>(async (modePending, mode) => {
        const modeRuns = await modePending
        return [...modeRuns, await evaluate(suite, definition, mode, runRoot, args.rawOutput)]
      }, Promise.resolve([]))
      return [...previous, ...next]
    }, Promise.resolve([]))
    const baseline = runs.filter((item) => item.mode === "baseline")
    const candidate = runs.filter((item) => item.mode === "candidate")
    const comparison = scoreComparison({
      baseline,
      candidate,
      thresholds: suite.thresholds,
      defaultCapabilityTools: suite.defaultCapabilityTools.length,
    })
    const report: Report = {
      suiteVersion: suite.version,
      metadata: {
        modelID: suite.model.id,
        quantization: process.env.QWEN_EVAL_QUANTIZATION ?? suite.model.quantization,
        serverCommit: process.env.QWEN_EVAL_SERVER_COMMIT ?? suite.model.serverCommit,
        openCodeCommit: await gitCommit(),
        seed: suite.model.seed,
        settings: suite.model.settings,
      },
      thresholds: suite.thresholds,
      defaultCapabilityTools: suite.defaultCapabilityTools.length,
      baseline,
      candidate,
      comparison,
    }
    await writeReports(args.output, report)
    process.stdout.write(`${JSON.stringify({ accepted: comparison.accepted, output: path.resolve(args.output) })}\n`)
    if (args.modes.length === 2 && !comparison.accepted) process.exitCode = 1
  } finally {
    await fs.rm(runRoot, { force: true, recursive: true })
  }
}

async function evaluate(
  suite: Suite,
  definition: CaseDefinition,
  mode: Mode,
  runRoot: string,
  rawOutput?: string,
): Promise<EvaluatedRun> {
  const directory = path.join(runRoot, `${definition.id}-${mode}`)
  const traceFile = path.join(directory, "trace.jsonl")
  const eventFile = path.join(directory, "events.jsonl")
  await prepareFixture(definition, directory)
  const configDirectory = path.join(directory, "config", "opencode")
  await fs.mkdir(configDirectory, { recursive: true })
  const providerSource = JSON.parse(
    await fs.readFile(
      process.env.OPENCODE_EVAL_PROVIDER_CONFIG ?? path.join(os.homedir(), ".config", "opencode", "opencode.json"),
      "utf8",
    ),
  ) as ProviderConfig
  const providerObserver = observeProvider(providerSource, suite.model.id, definition.requiredCapabilities ?? [])
  let result: Awaited<ReturnType<typeof runOwnedProcess>>
  const started = performance.now()
  try {
    await fs.writeFile(
      path.join(configDirectory, "opencode.json"),
      `${JSON.stringify(buildEvaluationConfig(providerObserver.config, mode, pathToFileURL(path.join(import.meta.dir, "fixture", "event-observer.ts")).href, suite.model.id), null, 2)}\n`,
      "utf8",
    )
    await fs.writeFile(traceFile, "", "utf8")
    await fs.writeFile(eventFile, "", "utf8")
    result = await runOwnedProcess({
      command: process.execPath,
      args: [
        "run",
        "--conditions=browser",
        path.join(import.meta.dir, "../../src/index.ts"),
        "run",
        "--dir",
        directory,
        "--model",
        suite.model.id,
        "--format",
        "json",
        "--auto",
        "--thinking",
        "--",
        definition.prompt ?? definition.description ?? definition.id,
      ],
      cwd: path.join(import.meta.dir, "../.."),
      environment: evaluationEnvironment(directory, configDirectory, eventFile),
    })
  } finally {
    providerObserver.stop()
  }
  const wallTimeMs = Math.round(performance.now() - started)
  await fs.writeFile(traceFile, result.stdout, "utf8")
  if (result.code !== 0) await fs.writeFile(path.join(directory, "stderr.log"), result.stderr, "utf8")
  if (rawOutput) {
    await fs.mkdir(rawOutput, { recursive: true })
    const prefix = path.join(rawOutput, `${definition.id}-${mode}`)
    await Promise.all([
      fs.writeFile(`${prefix}.jsonl`, result.stdout, "utf8"),
      fs.writeFile(`${prefix}.stderr`, result.stderr, "utf8"),
      fs.copyFile(eventFile, `${prefix}.events.jsonl`),
    ])
  }
  const trace = parseJsonLines<Trace>(result.stdout)
  const events = parseJsonLines<CapabilityEvent>(await fs.readFile(eventFile, "utf8"))
  const { toolCalls, activations } = readTraceEvidence(trace)
  const verifiedOutcomes = await Promise.all(
    definition.criteria.map((criterion) => verify(criterion, definition, directory, toolCalls, activations, events)),
  )
  const finalText = trace.filter((item) => item.type === "text" && item.part?.text).at(-1)?.part?.text
  const score = scoreCase(definition, { verifiedOutcomes, toolCalls, activations, finalText })
  const finishes = trace.filter((item) => item.type === "step_finish" && item.part?.tokens)
  const first = finishes[0]?.part?.tokens
  const providerInputTokens = sum(finishTokens(finishes, "input"))
  const assistantOutputTokens = sum(finishTokens(finishes, "output"))
  const rawPrefillTokens = first ? (first.input ?? 0) + (first.cache?.read ?? 0) + (first.cache?.write ?? 0) : null
  const firstUseful = trace.find(
    (item) =>
      item.type === "tool_use" &&
      item.part?.state?.status === "completed" &&
      !item.part.tool?.startsWith("capability_"),
  )
  const firstTimestamp = trace.find((item) => typeof item.timestamp === "number")?.timestamp
  return {
    ...score,
    caseVersion: definition.version,
    mode,
    verifiedOutcomes,
    toolTrace: toolCalls,
    capabilityEvents: events.map((event) => event.type),
    incorrectToolCallRate: toolCalls.length === 0 ? 0 : score.incorrectToolCalls / toolCalls.length,
    providerInputTokens,
    rawPrefillTokens,
    assistantOutputTokens,
    timeToFirstUsefulActionMs: firstUseful?.timestamp && firstTimestamp ? firstUseful.timestamp - firstTimestamp : null,
    wallTimeMs,
    capabilitySchemaCost: providerObserver.comparison(),
  }
}

export async function prepareFixture(definition: CaseDefinition, directory: string) {
  await fs.mkdir(directory, { recursive: true })
  const repository = await runOwnedProcess({
    command: "/usr/bin/git",
    args: ["init", "--quiet", directory],
    cwd: directory,
    environment: process.env,
  })
  if (repository.code !== 0)
    throw new Error(`Unable to initialize isolated eval repository: ${repository.stderr.trim()}`)
  await fs.writeFile(path.join(directory, "README.md"), `# ${definition.id}\n`, "utf8")
  if (definition.fixture !== "proof-capability") return
  const pack = path.join(directory, ".opencode", "capabilities", "eval-proof")
  await fs.mkdir(pack, { recursive: true })
  await fs.writeFile(
    path.join(pack, "capability.json"),
    `${JSON.stringify(
      {
        id: "eval-proof",
        version: 1,
        description: "Create an externally verified proof artifact with exact requested content.",
        platforms: ["darwin", "linux"],
        skills: [],
        runtimes: [
          {
            id: "writer",
            type: "mcp",
            command: [process.execPath, path.join(import.meta.dir, "fixture", "proof-mcp.ts")],
            tools: ["write_proof"],
          },
        ],
        profiles: { default: { description: "Create only the proof artifact.", skills: [], runtimes: ["writer"] } },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
}

function evaluationEnvironment(directory: string, configDirectory: string, eventFile: string) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          ![
            "OPENCODE_CONFIG",
            "OPENCODE_CONFIG_CONTENT",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_PURE",
            "XDG_CONFIG_HOME",
          ].includes(key),
      ),
    ),
    OPENCODE_CONFIG_DIR: configDirectory,
    XDG_CONFIG_HOME: path.dirname(configDirectory),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    CAPABILITY_EVAL_EVENT_FILE: eventFile,
    CAPABILITY_EVAL_PROOF_FILE: path.join(directory, ".opencode", "capabilities", "eval-proof", "proof.txt"),
  }
}

function observeProvider(
  config: ProviderConfig,
  modelID: string,
  capabilityIDs: ReadonlyArray<string>,
): SchemaObserver {
  const providerID = modelID.split("/")[0]
  const selected = config.provider?.[providerID]
  if (!isRecord(selected)) throw new Error(`Configured provider is invalid: ${providerID}`)
  const options = selected.options
  if (!isRecord(options) || typeof options.baseURL !== "string") {
    throw new Error(`Configured provider has no baseURL: ${providerID}`)
  }
  const upstreamBase = new URL(options.baseURL)
  const requestBodies: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const bytes = await request.arrayBuffer()
      if (bytes.byteLength > 0) {
        try {
          requestBodies.push(JSON.parse(new TextDecoder().decode(bytes)))
        } catch {
          // Non-JSON provider requests carry no tool schemas and are intentionally ignored.
        }
      }
      const incoming = new URL(request.url)
      const upstream = new URL(upstreamBase)
      const suffix = incoming.pathname.replace(/^\/observe\/?/, "")
      upstream.pathname = `${upstream.pathname.replace(/\/$/, "")}/${suffix}`
      upstream.search = incoming.search
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.delete("content-length")
      const response = await fetch(upstream, {
        method: request.method,
        headers,
        body: bytes.byteLength > 0 ? bytes : undefined,
        signal: request.signal,
      })
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    },
  })
  return {
    config: {
      ...config,
      provider: {
        ...config.provider,
        [providerID]: {
          ...selected,
          options: { ...options, baseURL: `http://127.0.0.1:${server.port}/observe` },
        },
      },
    },
    comparison: () => summarizeProviderSchemas(requestBodies, capabilityIDs),
    stop: () => server.stop(true),
  }
}

function providerCapabilityDefinitions(body: unknown, capabilityIDs: ReadonlyArray<string>): ToolDefinition[] {
  if (!isRecord(body) || !Array.isArray(body.tools)) return []
  return body.tools.flatMap((item) => {
    if (!isRecord(item)) return []
    const source = isRecord(item.function) ? item.function : item
    if (typeof source.name !== "string") return []
    const name = source.name
    const capabilityTool =
      managementTools.has(name) || capabilityIDs.some((capability) => name.startsWith(`${capability}_`))
    if (!capabilityTool) return []
    return [
      {
        name,
        description: typeof source.description === "string" ? source.description : "",
        inputSchema: isRecord(source.parameters) ? source.parameters : {},
      } as ToolDefinition,
    ]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

async function verify(
  criterion: CaseDefinition["criteria"][number],
  definition: CaseDefinition,
  directory: string,
  toolCalls: ReadonlyArray<{ readonly name: string; readonly status: "completed" | "error" }>,
  activations: ReadonlyArray<{ readonly capability: string; readonly profiles: ReadonlyArray<string> }>,
  events: ReadonlyArray<CapabilityEvent>,
) {
  const verifier = criterion.verifier
  if (!verifier) return { criterion: criterion.id, passed: false, evidenceRef: "missing-verifier" }
  if (verifier.type === "artifact") {
    const content = await fs.readFile(path.join(directory, verifier.path), "utf8").catch(() => undefined)
    const passed = content !== undefined && (verifier.contains === undefined || content === verifier.contains)
    return { criterion: criterion.id, passed, evidenceRef: `artifact:${criterion.id}` }
  }
  if (verifier.type === "tool") {
    const passed = toolCalls.some(
      (call) => call.name === verifier.name && call.status === (verifier.status ?? "completed"),
    )
    return { criterion: criterion.id, passed, evidenceRef: `tool:${verifier.name}` }
  }
  if (verifier.type === "activation") {
    const activation = activations.find((item) => item.capability === verifier.capability)
    const passed = !!activation && (!verifier.profiles || sameStrings(activation.profiles, verifier.profiles))
    return { criterion: criterion.id, passed, evidenceRef: `activation:${verifier.capability}` }
  }
  if (verifier.type === "event") {
    const passed = events.some((event) => event.type === verifier.event)
    return { criterion: criterion.id, passed, evidenceRef: `event:${verifier.event}` }
  }
  const required = new Set(definition.requiredCapabilities ?? [])
  const passed = activations.every((activation) => required.has(activation.capability))
  return { criterion: criterion.id, passed, evidenceRef: "activation:set" }
}

async function terminateOwnedProcessGroup(pid: number) {
  if (!groupAlive(pid)) return
  signalGroup(pid, "SIGTERM")
  for (let attempt = 0; attempt < 50 && groupAlive(pid); attempt++) await Bun.sleep(10)
  if (groupAlive(pid)) signalGroup(pid, "SIGKILL")
  for (let attempt = 0; attempt < 50 && groupAlive(pid); attempt++) await Bun.sleep(10)
}

function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error
  }
}

function parseJsonLines<T>(input: string): T[] {
  return input
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T]
      } catch {
        return []
      }
    })
}

function finishTokens(finishes: ReadonlyArray<Trace>, key: "input" | "output") {
  return finishes.map((item) => {
    const tokens = item.part?.tokens
    if (!tokens) return 0
    if (key === "output") return (tokens.output ?? 0) + (tokens.reasoning ?? 0)
    return (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
  })
}

function sum(values: ReadonlyArray<number>) {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0)
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.toSorted().every((value, index) => value === right.toSorted()[index])
}

function resultRow(item: EvaluatedRun) {
  const schema = item.capabilitySchemaCost?.deltaTokens ?? "n/a"
  return `| ${item.mode} | ${item.caseID} | ${item.verifiedCriteria}/${item.totalCriteria} | ${item.incorrectToolCalls} | ${item.providerInputTokens ?? "n/a"} | ${item.rawPrefillTokens ?? "n/a"} | ${item.assistantOutputTokens ?? "n/a"} | ${item.timeToFirstUsefulActionMs ?? "n/a"} ms | ${item.wallTimeMs} ms | ${schema} tokens |`
}

function formatRate(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

async function gitCommit() {
  const result = await runOwnedProcess({
    command: "/usr/bin/git",
    args: ["rev-parse", "HEAD"],
    cwd: path.join(import.meta.dir, "../../.."),
    environment: process.env,
  })
  return result.code === 0 ? result.stdout.trim() : "unknown"
}

if (import.meta.main) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
