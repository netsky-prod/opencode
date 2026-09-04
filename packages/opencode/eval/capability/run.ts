import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import z from "zod"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { CapabilityTokenEstimate } from "@opencode-ai/core/capability/token-estimate"
import type { ToolDefinition } from "@opencode-ai/llm"
import { loadSuite, redact, scoreCase, scoreComparison, type CaseDefinition, type CaseScore, type Suite } from "./score"

export type Mode = "baseline" | "candidate"

export function effectivePrompt(definition: CaseDefinition) {
  const text = `${definition.requiredCapabilities?.length ? "First inspect the available tools. If capability discovery is unavailable, reply BLOCKED and stop. Do not invent tool names or delegate to an agent named '...'. " : ""}${definition.prompt ?? definition.description ?? definition.id}`
  return { text, digest: createHash("sha256").update(text).digest("hex") }
}

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
    readonly state?: { readonly status?: string; readonly input?: unknown; readonly output?: unknown }
    readonly tokens?: {
      readonly input?: number
      readonly output?: number
      readonly reasoning?: number
      readonly cache?: { readonly read?: number; readonly write?: number }
    }
  }
}

type CapabilityEvent = { readonly type: string; readonly data?: Record<string, unknown> }
const traceSchema: z.ZodType<Trace> = z.object({
  type: z.string().optional(),
  timestamp: z.number().optional(),
  part: z
    .object({
      type: z.string().optional(),
      tool: z.string().optional(),
      text: z.string().optional(),
      state: z
        .object({ status: z.string().optional(), input: z.unknown().optional(), output: z.unknown().optional() })
        .optional(),
      tokens: z
        .object({
          input: z.number().optional(),
          output: z.number().optional(),
          reasoning: z.number().optional(),
          cache: z.object({ read: z.number().optional(), write: z.number().optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
})
const eventSchema: z.ZodType<CapabilityEvent> = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
})

type EvaluatedRun = CaseScore & {
  readonly initialToolNames: ReadonlyArray<string>
  readonly finalToolNames: ReadonlyArray<string>
  readonly caseVersion: number
  readonly promptDigest: string
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
    readonly sourceDigest: string
    readonly dirty: boolean
    readonly serverCommitProbe: string
    readonly seedStatus: string
    readonly contextStatus: string
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
  readonly comparison: () => ReturnType<typeof summarizeProviderSchemas>
  readonly stop: () => void
  readonly serverCommit: () => string | undefined
}

const managementTools = new Set(["capability_disable", "capability_enable", "capability_search", "capability_status"])

// An explicit eval surface makes newly introduced or inactive pack tools fail closed.
const baseTools = new Set([
  "read",
  "glob",
  "grep",
  "task",
  "webfetch",
  "websearch",
  "todowrite",
  "todoread",
  "skill",
  "question",
  "lsp",
  "plan_enter",
  "plan_exit",
  "invalid",
  "bash",
  "edit",
  "write",
  "apply_patch",
  "execute",
  "loop_create",
  "loop_list",
  "loop_update",
  "loop_delete",
  "loop_checkpoint",
  "loop_wakeup",
])

export function schemaBudget(baseline: ReadonlyArray<string>, candidate: ReadonlyArray<string>) {
  if (baseline.length === 0 || new Set(candidate).size !== candidate.length) return false
  if (baseline.some((name) => !baseTools.has(name))) return false
  return sameStrings(candidate, [...baseline, ...managementTools])
}

export async function validateRawOutput(directory: string) {
  const resolved = path.resolve(directory)
  // A raw sink is allowed only when Git itself proves that its contents are ignored.
  // Reject existing symlink aliases before checking the lexical ignore rule.
  const ancestor = async (value: string): Promise<string> => {
    const stat = await fs.lstat(value).catch(() => undefined)
    if (!stat) return ancestor(path.dirname(value))
    if ((await fs.realpath(value)) !== value) throw new Error("Raw output must not use symlink paths")
    return value
  }
  await ancestor(resolved)
  const result = await runOwnedProcess({
    command: "/usr/bin/git",
    args: ["check-ignore", "--quiet", "--", resolved + path.sep],
    cwd: path.join(import.meta.dir, "../.."),
    environment: process.env,
  })
  if (result.code !== 0) throw new Error("Raw output must be inside an explicitly Git-ignored directory")
}

export function buildEvaluationConfig(
  source: ProviderConfig,
  mode: Mode,
  observer: string,
  modelID: string,
  settings: Suite["model"]["settings"] = { temperature: 0 },
) {
  const providerID = modelID.split("/")[0]
  const provider = source.provider?.[providerID]
  if (!provider) throw new Error(`Configured provider is missing: ${providerID}`)
  const selected = isRecord(provider) ? provider : {}
  const models = isRecord(selected.models) ? selected.models : {}
  const modelName = modelID.slice(providerID.length + 1)
  const model = isRecord(models[modelName]) ? models[modelName] : {}
  const limit = isRecord(model.limit) ? model.limit : {}
  const configured =
    typeof settings.contextTokens === "number"
      ? {
          ...selected,
          models: { ...models, [modelName]: { ...model, limit: { ...limit, context: settings.contextTokens } } },
        }
      : provider
  const permission = {
    bash: "deny",
    edit: "deny",
    write: "deny",
    patch: "deny",
    ...(mode === "baseline" ? { "capability_*": "deny" } : {}),
  }
  return {
    model: modelID,
    provider: { [providerID]: configured },
    plugin: [observer],
    agent: { build: { temperature: typeof settings.temperature === "number" ? settings.temperature : 0 } },
    permission,
  }
}

export function readTraceEvidence(trace: ReadonlyArray<Trace>) {
  const toolCalls = trace.flatMap((item) => {
    if (item.type !== "tool_use" || !item.part?.tool) return []
    const outcome = item.part.tool === "capability_enable" ? activationOutput(item)?.state : undefined
    return [
      {
        name: item.part.tool,
        status:
          item.part.state?.status === "completed" && outcome !== "failed" && outcome !== "unsupported"
            ? ("completed" as const)
            : ("error" as const),
      },
    ]
  })
  const activations = trace.flatMap((item) => {
    if (item.type !== "tool_use" || item.part?.tool !== "capability_enable" || item.part.state?.status !== "completed")
      return []
    const output = activationOutput(item)
    if (!output || !["active", "degraded"].includes(output.state)) return []
    const input = item.part.state.input
    if (!isRecord(input) || input.id !== output.id) return []
    return [{ capability: output.id, profiles: output.profiles }]
  })
  return { toolCalls, activations }
}

function activationOutput(item: Trace) {
  const output = item.part?.state?.output
  const schema = z.object({
    id: z.string(),
    state: z.enum(["active", "degraded", "failed", "unsupported"]),
    profiles: z.array(z.string()),
  })
  if (typeof output !== "string") return schema.safeParse(output).data
  try {
    return schema.safeParse(JSON.parse(output)).data
  } catch {
    return undefined
  }
}

export function summarizeProviderSchemas(requestBodies: ReadonlyArray<unknown>) {
  const taskSnapshots = requestBodies.map(providerToolDefinitions).filter((snapshot) => snapshot.length > 0)
  const baseline = taskSnapshots[0] ?? []
  const activated = taskSnapshots.at(-1) ?? baseline
  return {
    initialToolNames: baseline.map((definition) => definition.name).toSorted(),
    finalToolNames: activated.map((definition) => definition.name).toSorted(),
    comparison: CapabilityTokenEstimate.compare(baseline, activated),
  }
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
  const cases = argv.flatMap((item, index) => {
    if (item !== "--case") return []
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) throw new Error("--case requires a value")
    return [next]
  })
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
  const handler = (signal: (typeof interrupted)[number]) => () => {
    interruption = signal
    abort()
  }
  const interrupt = { SIGINT: handler("SIGINT"), SIGTERM: handler("SIGTERM"), SIGHUP: handler("SIGHUP") }
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

export async function writeReports(directory: string, report: Report) {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "comparison.json"), `${JSON.stringify(redact(report), null, 2)}\n`, "utf8")
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
  await fs.writeFile(path.join(directory, "comparison.md"), String(redact(markdown)), "utf8")
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (args.rawOutput) await validateRawOutput(args.rawOutput)
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
  const source = await sourceIdentity()
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
    const actualBudget =
      baseline.length > 0 &&
      candidate.length === baseline.length &&
      candidate.every((run) => {
        const control = baseline.find((item) => item.caseID === run.caseID)
        return !!control && schemaBudget(control.initialToolNames, run.initialToolNames)
      })
    const comparison = scoreComparison({
      baseline,
      candidate,
      thresholds: suite.thresholds,
      defaultCapabilityTools: actualBudget ? managementTools.size : Number.MAX_SAFE_INTEGER,
    })
    const report: Report = {
      suiteVersion: suite.version,
      metadata: {
        modelID: suite.model.id,
        quantization: process.env.QWEN_EVAL_QUANTIZATION ?? suite.model.quantization,
        serverCommit: process.env.QWEN_EVAL_SERVER_COMMIT ?? observedServerCommit ?? "unavailable",
        serverCommitProbe: process.env.QWEN_EVAL_SERVER_COMMIT
          ? "operator supplied"
          : "inspected x-server-commit and x-build-commit response headers",
        openCodeCommit: source.commit,
        sourceDigest: source.digest,
        dirty: source.dirty,
        seedStatus:
          suite.model.seed === null
            ? "not requested"
            : "sent as seed in each task request; provider determinism not guaranteed",
        contextStatus: "applied to client model context limit; server capacity not independently verified",
        seed: suite.model.seed,
        settings: suite.model.settings,
      },
      thresholds: suite.thresholds,
      defaultCapabilityTools: Math.max(
        0,
        ...candidate.map((run) => run.initialToolNames.filter((name) => managementTools.has(name)).length),
      ),
      baseline,
      candidate,
      comparison,
    }
    await writeReports(args.output, report)
    process.stdout.write(`${JSON.stringify({ accepted: comparison.accepted })}\n`)
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
  const providerSource: unknown = JSON.parse(
    await fs.readFile(
      process.env.OPENCODE_EVAL_PROVIDER_CONFIG ?? path.join(os.homedir(), ".config", "opencode", "opencode.json"),
      "utf8",
    ),
  )
  if (!isRecord(providerSource) || !isRecord(providerSource.provider)) throw new Error("Invalid provider configuration")
  const providerObserver = observeProvider({ provider: providerSource.provider }, suite.model)
  let result: Awaited<ReturnType<typeof runOwnedProcess>>
  const started = performance.now()
  try {
    await fs.writeFile(
      path.join(configDirectory, "opencode.json"),
      `${JSON.stringify(buildEvaluationConfig(providerObserver.config, mode, pathToFileURL(path.join(import.meta.dir, "fixture", "event-observer.ts")).href, suite.model.id, suite.model.settings), null, 2)}\n`,
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
        ...(suite.model.settings.reasoning === true ? ["--thinking"] : []),
        "--",
        effectivePrompt(definition).text,
      ],
      cwd: path.join(import.meta.dir, "../.."),
      environment: evaluationEnvironment(directory, configDirectory, eventFile),
    })
  } finally {
    observedServerCommit ??= providerObserver.serverCommit()
    providerObserver.stop()
  }
  const wallTimeMs = Math.round(performance.now() - started)
  await fs.writeFile(traceFile, result.stdout, "utf8")
  if (result.code !== 0) await fs.writeFile(path.join(directory, "stderr.log"), result.stderr, "utf8")
  if (rawOutput) {
    await validateRawOutput(rawOutput)
    await fs.mkdir(rawOutput, { recursive: true })
    const prefix = path.join(rawOutput, `${definition.id}-${mode}`)
    for (const file of [`${prefix}.jsonl`, `${prefix}.stderr`, `${prefix}.events.jsonl`]) {
      const entry = await fs.lstat(file).catch(() => undefined)
      if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error("Raw artifact must be a regular file")
    }
    await Promise.all([
      fs.writeFile(`${prefix}.jsonl`, result.stdout, "utf8"),
      fs.writeFile(`${prefix}.stderr`, result.stderr, "utf8"),
      fs.copyFile(eventFile, `${prefix}.events.jsonl`),
    ])
  }
  const trace = parseJsonLines(result.stdout, traceSchema)
  const events = parseJsonLines(await fs.readFile(eventFile, "utf8"), eventSchema)
  const { toolCalls, activations } = readTraceEvidence(trace)
  const verifiedOutcomes = await Promise.all(
    definition.criteria.map((criterion) =>
      verifyCriterion(criterion, definition, directory, toolCalls, activations, events, trace),
    ),
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
    promptDigest: effectivePrompt(definition).digest,
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
    initialToolNames: providerObserver.comparison().initialToolNames,
    finalToolNames: providerObserver.comparison().finalToolNames,
    capabilitySchemaCost: providerObserver.comparison().comparison,
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
  if (definition.fixture === "checkpoint") {
    await fs.writeFile(path.join(directory, "checkpoint-evidence.txt"), "CHECKPOINT_VERIFIED_742\n")
    return
  }
  if (definition.fixture === "outcome-capability") {
    await prepareOutcomeFixture(definition, directory)
    return
  }
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

async function prepareOutcomeFixture(definition: CaseDefinition, directory: string) {
  const capability = definition.requiredCapabilities?.[0]
  const profile = capability ? definition.expectedProfiles?.[capability]?.[0] : undefined
  if (!capability || !profile) throw new Error(`Outcome fixture requires one capability/profile: ${definition.id}`)
  const input = path.join(directory, ".eval", "input")
  await fs.mkdir(input, { recursive: true })
  const seeded: Record<string, string> = {
    browser: '<main data-state="ready">Capability evaluation ready</main>\n',
    research: "Capability evals require external evidence.\nFixture primary source, revision 1.\n",
    mobile: '{"bundle":"com.example.eval","target":"ios"}\n',
    security: "API_TOKEN=EVAL-SECRET-001\n",
    documents: "Evaluation document\nThe verification code is DOC-742.\n",
    github: "repository fixture\n",
    deploy: "GET /health -> ok\n",
    "missing-dependency-recovery": "Create ../dependency-ready after the failed activation, then retry.\n",
  }
  const names: Record<string, string> = {
    browser: "page.html",
    research: "primary-source.txt",
    mobile: "mobile-project.json",
    security: "vulnerable.env",
    documents: "document.txt",
    github: "repository.txt",
    deploy: "service.txt",
    "missing-dependency-recovery": "remediation.txt",
  }
  const content = seeded[definition.id]
  const name = names[definition.id]
  if (!content || !name) throw new Error(`Missing deterministic fixture input: ${definition.id}`)
  await fs.writeFile(path.join(input, name), content, "utf8")
  const pack = path.join(directory, ".opencode", "capabilities", capability)
  await fs.mkdir(pack, { recursive: true })
  await fs.writeFile(
    path.join(pack, "capability.json"),
    `${JSON.stringify(
      {
        id: capability,
        version: 1,
        description: `Execute the deterministic ${definition.id} evaluation outcome and preserve external evidence.`,
        platforms: ["darwin", "linux"],
        skills: [],
        runtimes: [
          {
            id: "fixture",
            type: "mcp",
            command: [process.execPath, path.join(import.meta.dir, "fixture", "outcome-mcp.ts")],
            tools:
              definition.id === "missing-dependency-recovery"
                ? ["verify_outcome", "repair_dependency"]
                : ["verify_outcome"],
          },
        ],
        profiles: {
          ...(definition.id === "mobile"
            ? {
                all: {
                  description: "Both iOS and Android tooling; unnecessary for an iOS-only request.",
                  skills: [],
                  runtimes: ["fixture"],
                },
                android: {
                  description: "Android-only tooling; unnecessary for an iOS request.",
                  skills: [],
                  runtimes: ["fixture"],
                },
              }
            : {}),
          ...(definition.id === "missing-dependency-recovery"
            ? {
                repair: {
                  description:
                    "After default activation fails, enable repair and call repair_dependency, then retry default.",
                  skills: [],
                  runtimes: ["fixture"],
                },
              }
            : {}),
          [profile]: {
            description: `Run only the deterministic ${definition.id} fixture.`,
            skills: [],
            runtimes: ["fixture"],
            ...(definition.id === "mobile" ? { platforms: ["darwin"] } : {}),
          },
        },
        ...(definition.id === "missing-dependency-recovery"
          ? {
              dependencies: [
                {
                  id: "fixture-ready",
                  check: [process.execPath, path.join(import.meta.dir, "fixture", "dependency-check.ts")],
                  profiles: [profile],
                },
              ],
            }
          : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  if (definition.id !== "github") return
  await fs.writeFile(
    path.join(directory, ".gitignore"),
    "config/\ntrace.jsonl\nevents.jsonl\nstderr.log\neval.sqlite*\n",
  )
  const add = await runOwnedProcess({
    command: "/usr/bin/git",
    args: ["add", "."],
    cwd: directory,
    environment: process.env,
  })
  if (add.code !== 0) throw new Error(`Unable to stage Git fixture: ${add.stderr.trim()}`)
  const commit = await runOwnedProcess({
    command: "/usr/bin/git",
    args: [
      "-c",
      "user.name=Capability Eval",
      "-c",
      "user.email=eval@invalid",
      "commit",
      "--quiet",
      "-m",
      "Initial fixture commit",
    ],
    cwd: directory,
    environment: process.env,
  })
  if (commit.code !== 0) throw new Error(`Unable to commit Git fixture: ${commit.stderr.trim()}`)
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
    OPENCODE_DB: path.join(directory, "eval.sqlite"),
    XDG_CONFIG_HOME: path.dirname(configDirectory),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    CAPABILITY_EVAL_EVENT_FILE: eventFile,
    CAPABILITY_EVAL_CASE: path.basename(directory).replace(/-(?:baseline|candidate)$/, ""),
    CAPABILITY_EVAL_ROOT: directory,
    CAPABILITY_EVAL_PROOF_FILE: path.join(directory, ".opencode", "capabilities", "eval-proof", "proof.txt"),
  }
}

let observedServerCommit: string | undefined

function observeProvider(config: ProviderConfig, model: Suite["model"]): SchemaObserver {
  const modelID = model.id
  const providerID = modelID.split("/")[0]
  const selected = config.provider?.[providerID]
  if (!isRecord(selected)) throw new Error(`Configured provider is invalid: ${providerID}`)
  const options = selected.options
  if (!isRecord(options) || typeof options.baseURL !== "string") {
    throw new Error(`Configured provider has no baseURL: ${providerID}`)
  }
  const upstreamBase = new URL(options.baseURL)
  const requestBodies: unknown[] = []
  let serverCommit: string | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      let bytes = new Uint8Array(await request.arrayBuffer())
      if (bytes.byteLength > 0) {
        try {
          const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
          if (isRecord(body) && Array.isArray(body.tools)) {
            if (model.seed !== null) body.seed = model.seed
            body.temperature = model.settings.temperature ?? 0
            bytes = new TextEncoder().encode(JSON.stringify(body))
          }
          if (isRecord(body) && Array.isArray(body.tools) && body.tools.length > 0) {
            // Retain only first/last schema snapshots, never prompts or request credentials.
            requestBodies[Math.min(requestBodies.length, 1)] = { tools: body.tools }
          }
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
      const revision = response.headers.get("x-server-commit") ?? response.headers.get("x-build-commit")
      if (revision && /^[a-f0-9]{7,64}$/i.test(revision)) serverCommit = revision
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
    comparison: () => summarizeProviderSchemas(requestBodies),
    serverCommit: () => serverCommit,
    stop: () => server.stop(true),
  }
}

function providerToolDefinitions(body: unknown): ToolDefinition[] {
  if (!isRecord(body) || !Array.isArray(body.tools)) return []
  return body.tools.flatMap((item) => {
    if (!isRecord(item)) return []
    const source = isRecord(item.function) ? item.function : item
    if (typeof source.name !== "string") return []
    return [
      {
        name: source.name,
        description: typeof source.description === "string" ? source.description : "",
        inputSchema: isRecord(source.parameters) ? source.parameters : {},
      } as ToolDefinition,
    ]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export async function verifyCriterion(
  criterion: CaseDefinition["criteria"][number],
  definition: CaseDefinition,
  directory: string,
  toolCalls: ReadonlyArray<{ readonly name: string; readonly status: "completed" | "error" }>,
  activations: ReadonlyArray<{ readonly capability: string; readonly profiles: ReadonlyArray<string> }>,
  events: ReadonlyArray<CapabilityEvent>,
  trace: ReadonlyArray<Trace> = [],
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
    const selected = activations.filter((item) => item.capability === verifier.capability)
    const passed =
      selected.length > 0 &&
      selected.every((activation) => !verifier.profiles || sameStrings(activation.profiles, verifier.profiles))
    return { criterion: criterion.id, passed, evidenceRef: `activation:${verifier.capability}` }
  }
  if (verifier.type === "event") {
    const passed = events.some((event) => event.type === verifier.event)
    return { criterion: criterion.id, passed, evidenceRef: `event:${verifier.event}` }
  }
  if (verifier.type === "binary-artifact") {
    const content = await fs.readFile(path.join(directory, verifier.path)).catch(() => undefined)
    const prefix = Buffer.from(verifier.prefix, "base64")
    const passed =
      content !== undefined &&
      content.byteLength >= verifier.minimumBytes &&
      content.subarray(0, prefix.length).equals(prefix)
    return { criterion: criterion.id, passed, evidenceRef: `binary-artifact:${criterion.id}` }
  }
  if (verifier.type === "git-clean") {
    const status = await runOwnedProcess({
      command: "/usr/bin/git",
      args: ["status", "--porcelain"],
      cwd: directory,
      environment: process.env,
    })
    return {
      criterion: criterion.id,
      passed: status.code === 0 && status.stdout.length === 0,
      evidenceRef: `git-status:${criterion.id}`,
    }
  }
  if (verifier.type === "port-closed") {
    const port = Number(await fs.readFile(path.join(directory, verifier.path), "utf8").catch(() => ""))
    const reachable =
      Number.isInteger(port) && port > 0 && port <= 65535
        ? await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }).then(
            () => true,
            () => false,
          )
        : true
    return { criterion: criterion.id, passed: !reachable, evidenceRef: `closed-port:${criterion.id}` }
  }
  if (verifier.type === "dependency-recovery") {
    const attempts = trace.filter(
      (item) =>
        item.type === "tool_use" &&
        item.part?.tool === "capability_enable" &&
        isRecord(item.part.state?.input) &&
        item.part.state.input.id === verifier.capability,
    )
    const failure = attempts.findIndex(
      (item) => item.part?.state?.status === "error" || activationOutput(item)?.state === "failed",
    )
    const failedInput = attempts[failure]?.part?.state?.input
    const profiles = isRecord(failedInput)
      ? Array.isArray(failedInput.profiles)
        ? failedInput.profiles
        : [failedInput.profile ?? "default"]
      : []
    const success = attempts.findIndex((item, index) => {
      const output = activationOutput(item)
      return (
        index > failure &&
        item.part?.state?.status === "completed" &&
        output?.id === verifier.capability &&
        output.state === "active" &&
        profiles.length > 0 &&
        sameStrings(
          output.profiles,
          profiles.filter((value): value is string => typeof value === "string"),
        )
      )
    })
    return {
      criterion: criterion.id,
      passed: failure >= 0 && success > failure,
      evidenceRef: `dependency-retry:${verifier.capability}`,
    }
  }
  if (verifier.type === "checkpoint-evidence") {
    const checkpoint = trace.find(
      (item) =>
        item.type === "tool_use" && item.part?.tool === "loop_checkpoint" && item.part.state?.status === "completed",
    )?.part?.state?.input
    const input = isRecord(checkpoint) ? checkpoint : {}
    const facts = Array.isArray(input.verifiedFacts) ? input.verifiedFacts : []
    const evidence = facts.some(
      (fact) =>
        isRecord(fact) &&
        Array.isArray(fact.evidence) &&
        fact.evidence.some((item) => typeof item === "string" && item.length > 0),
    )
    const artifacts =
      Array.isArray(input.artifacts) && input.artifacts.some((item) => typeof item === "string" && item.length > 0)
    const nextAction = typeof input.nextAction === "string" && input.nextAction.trim().length > 0
    const persisted = await (async () => {
      if (typeof input.id !== "string" || !(await Bun.file(path.join(directory, "eval.sqlite")).exists())) return false
      const { Database } = await import("bun:sqlite")
      const db = new Database(path.join(directory, "eval.sqlite"), { readonly: true })
      try {
        const row = db
          .query<
            { state: string; checkpoint_json: string },
            [string]
          >("SELECT state, checkpoint_json FROM session_loop WHERE id = ?")
          .get(input.id)
        if (!row || row.state !== "completed") return false
        const value: unknown = JSON.parse(row.checkpoint_json)
        if (!isRecord(value) || !Array.isArray(value.verifiedFacts) || !Array.isArray(value.artifacts)) return false
        const content = await fs.readFile(path.join(directory, "checkpoint-evidence.txt"), "utf8")
        return (
          content.trim() === "CHECKPOINT_VERIFIED_742" &&
          value.artifacts.includes("checkpoint-evidence.txt") &&
          typeof value.nextAction === "string" &&
          value.nextAction.length > 0 &&
          value.verifiedFacts.some(
            (fact) =>
              isRecord(fact) &&
              typeof fact.claim === "string" &&
              fact.claim.includes(content.trim()) &&
              Array.isArray(fact.evidence) &&
              fact.evidence.includes("checkpoint-evidence.txt"),
          )
        )
      } finally {
        db.close()
      }
    })().catch(() => false)
    return {
      criterion: criterion.id,
      passed: facts.length > 0 && evidence && artifacts && nextAction && persisted,
      evidenceRef: `checkpoint-database:${criterion.id}`,
    }
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

function parseJsonLines<T>(input: string, schema: z.ZodType<T>): T[] {
  return input
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const result = schema.safeParse(JSON.parse(line))
        return result.success ? [result.data] : []
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

async function sourceIdentity() {
  const result = await runOwnedProcess({
    command: "/usr/bin/git",
    args: ["rev-parse", "HEAD"],
    cwd: path.join(import.meta.dir, "../../.."),
    environment: process.env,
  })
  const cwd = path.join(import.meta.dir, "../../../..")
  const status = await runOwnedProcess({
    command: "/usr/bin/git",
    args: ["status", "--porcelain", "--untracked-files=all"],
    cwd,
    environment: process.env,
  })
  const diff = await runOwnedProcess({
    command: "/usr/bin/git",
    args: ["diff", "HEAD", "--", "."],
    cwd,
    environment: process.env,
  })
  const digest = createHash("sha256").update(result.stdout).update(diff.stdout)
  for (const file of (
    await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: import.meta.dir, onlyFiles: true }))
  ).sort()) {
    if (file.startsWith("reports/")) continue
    digest.update(file).update(await fs.readFile(path.join(import.meta.dir, file)))
  }
  return {
    commit: result.code === 0 ? result.stdout.trim() : "unknown",
    dirty: status.stdout.length > 0,
    digest: digest.digest("hex"),
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    process.stderr.write(`${publicFailure(error)}\n`)
    process.exitCode = 1
  })
}

export function publicFailure(error: unknown) {
  const message = error instanceof Error ? error.message : ""
  const safe = new Set([
    "--case requires a value",
    "--output requires a value",
    "--raw-output requires a value",
    "RUNPOD_QWEN_API_KEY is required",
    "One or more requested eval cases do not exist",
    "Raw output must be inside an explicitly Git-ignored directory",
    "Raw output must not use symlink paths",
    "Raw artifact must be a regular file",
  ])
  return safe.has(message)
    ? message
    : "Capability evaluation failed. Check provider availability and the configured fixture prerequisites."
}
