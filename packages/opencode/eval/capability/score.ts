import fs from "fs/promises"
import z from "zod"

export type Criterion = {
  readonly id: string
  readonly description: string
  readonly verifier?:
    | { readonly type: "artifact"; readonly path: string; readonly contains?: string }
    | { readonly type: "tool"; readonly name: string; readonly status?: "completed" | "error" }
    | { readonly type: "activation"; readonly capability: string; readonly profiles?: ReadonlyArray<string> }
    | { readonly type: "event"; readonly event: string }
    | {
        readonly type: "binary-artifact"
        readonly path: string
        readonly prefix: string
        readonly minimumBytes: number
      }
    | { readonly type: "git-clean" }
    | { readonly type: "port-closed"; readonly path: string }
    | { readonly type: "dependency-recovery"; readonly capability: string }
    | { readonly type: "checkpoint-evidence" }
    | { readonly type: "no-unnecessary-activation" }
}

export type CaseDefinition = {
  readonly id: string
  readonly version: number
  readonly description?: string
  readonly prompt?: string
  readonly coverage?: ReadonlyArray<string>
  readonly requiredCapabilities?: ReadonlyArray<string>
  readonly expectedProfiles?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly criteria: ReadonlyArray<Criterion>
  readonly fixture?: "proof-capability" | "outcome-capability" | "checkpoint"
}

export type Suite = {
  readonly version: number
  readonly model: {
    readonly id: string
    readonly quantization: string
    readonly serverCommit: string
    readonly seed: number | null
    readonly settings: Readonly<Record<string, string | number | boolean | null>>
  }
  readonly thresholds: {
    readonly minimumCompletionGain: number
    readonly maxDefaultCapabilityTools: number
  }
  readonly defaultCapabilityTools: ReadonlyArray<string>
  readonly cases: ReadonlyArray<CaseDefinition>
}

export type RunEvidence = {
  readonly finalText?: string
  readonly verifiedOutcomes: ReadonlyArray<{
    readonly criterion: string
    readonly passed: boolean
    readonly evidenceRef: string
  }>
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly status: "completed" | "error" }>
  readonly activations: ReadonlyArray<{ readonly capability: string; readonly profiles: ReadonlyArray<string> }>
}

export type CaseScore = {
  readonly caseID: string
  readonly completed: boolean
  readonly verifiedCriteria: number
  readonly totalCriteria: number
  readonly incorrectToolCalls: number
}

export type Comparison = {
  readonly accepted: boolean
  readonly baselineCompletionRate: number
  readonly candidateCompletionRate: number
  readonly completionGain: number
  readonly schemaBudgetPassed: boolean
  readonly explanation: string
}

export async function loadSuite(file: string): Promise<Suite> {
  const strings = z.array(z.string())
  const verifier = z.discriminatedUnion("type", [
    z.object({ type: z.literal("artifact"), path: z.string(), contains: z.string().optional() }),
    z.object({ type: z.literal("tool"), name: z.string(), status: z.enum(["completed", "error"]).optional() }),
    z.object({ type: z.literal("activation"), capability: z.string(), profiles: strings.optional() }),
    z.object({ type: z.literal("event"), event: z.string() }),
    z.object({
      type: z.literal("binary-artifact"),
      path: z.string(),
      prefix: z.string(),
      minimumBytes: z.number().int().positive(),
    }),
    z.object({ type: z.literal("git-clean") }),
    z.object({ type: z.literal("port-closed"), path: z.string() }),
    z.object({ type: z.literal("dependency-recovery"), capability: z.string() }),
    z.object({ type: z.literal("checkpoint-evidence") }),
    z.object({ type: z.literal("no-unnecessary-activation") }),
  ])
  const value = z
    .object({
      version: z.literal(1),
      model: z.object({
        id: z.string(),
        quantization: z.string(),
        serverCommit: z.string(),
        seed: z.number().int().nullable(),
        settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
      }),
      thresholds: z.object({ minimumCompletionGain: z.number().positive(), maxDefaultCapabilityTools: z.literal(4) }),
      defaultCapabilityTools: strings,
      cases: z
        .array(
          z.object({
            id: z.string().regex(/^[a-z0-9-]+$/),
            version: z.number().int().positive(),
            description: z.string().optional(),
            prompt: z.string().optional(),
            coverage: strings.optional(),
            requiredCapabilities: strings.optional(),
            expectedProfiles: z.record(z.string(), strings).optional(),
            fixture: z.enum(["proof-capability", "outcome-capability", "checkpoint"]).optional(),
            criteria: z
              .array(z.object({ id: z.string(), description: z.string(), verifier: verifier.optional() }))
              .min(1),
          }),
        )
        .min(1),
    })
    .parse(JSON.parse(await fs.readFile(file, "utf8")))
  if (new Set(value.cases.map((item) => item.id)).size !== value.cases.length) {
    throw new Error("Capability eval suite case IDs must be unique")
  }
  if (value.cases.some((item) => !Number.isInteger(item.version) || item.version < 1)) {
    throw new Error("Capability eval suite cases must have positive integer versions")
  }
  if (value.defaultCapabilityTools.length !== value.thresholds.maxDefaultCapabilityTools) {
    throw new Error("Default capability tool list exceeds or understates the declared schema budget")
  }
  return value
}

export function scoreCase(definition: CaseDefinition, run: RunEvidence): CaseScore {
  const evidence = new Map(
    run.verifiedOutcomes
      .filter((item) => item.passed && item.evidenceRef.trim().length > 0)
      .map((item) => [item.criterion, item]),
  )
  const verifiedCriteria = definition.criteria.filter((criterion) => evidence.has(criterion.id)).length
  const required = new Set(definition.requiredCapabilities ?? [])
  const failedCalls = run.toolCalls.filter((call) => call.status === "error").length
  const unnecessary = run.activations.filter((activation) => !required.has(activation.capability)).length
  const oversized = run.activations.filter((activation) => {
    const expected = definition.expectedProfiles?.[activation.capability]
    if (!expected) return false
    return !sameStrings(activation.profiles, expected)
  }).length
  return {
    caseID: definition.id,
    completed: definition.criteria.length > 0 && verifiedCriteria === definition.criteria.length,
    verifiedCriteria,
    totalCriteria: definition.criteria.length,
    incorrectToolCalls: failedCalls + unnecessary + oversized,
  }
}

export function scoreComparison(input: {
  readonly baseline: ReadonlyArray<CaseScore>
  readonly candidate: ReadonlyArray<CaseScore>
  readonly thresholds: Suite["thresholds"]
  readonly defaultCapabilityTools: number
}): Comparison {
  const baselineCompletionRate = completionRate(input.baseline)
  const candidateCompletionRate = completionRate(input.candidate)
  const completionGain = candidateCompletionRate - baselineCompletionRate
  const schemaBudgetPassed = input.defaultCapabilityTools <= input.thresholds.maxDefaultCapabilityTools
  const improved =
    completionGain >= input.thresholds.minimumCompletionGain && candidateCompletionRate > baselineCompletionRate
  return {
    accepted: improved && schemaBudgetPassed,
    baselineCompletionRate,
    candidateCompletionRate,
    completionGain,
    schemaBudgetPassed,
    explanation: `Candidate must improve verified completion by at least ${input.thresholds.minimumCompletionGain} and retain no more than ${input.thresholds.maxDefaultCapabilityTools} management schemas. Model claims are never evidence.`,
  }
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value)
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/^(?:authorization|api[_-]?key|access[_-]?token|token|password|secret|client[_-]?secret|credentials?|cookie|headers?|environment|session(?:id)?|raw(?:diagnostics?)?)$/i.test(
            key,
          ),
      )
      .map(([key, item]) => [key, redact(item)]),
  )
}

function redactText(value: string) {
  if (capabilityEventTypes.has(value)) return value
  return value
    .replace(/\b(?:token|api[_-]?key|client[_-]?secret|password|secret)\s*[=:]\s*[^\s,"']+/gi, "credential=<redacted>")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/https?:\/\/[^\s"')]+/gi, "<redacted-url>")
    .replace(/(?:\/Users|\/home|\/root|\/private|\/var|\/tmp)\/[^\s"']+/g, "<redacted-path>")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, "<redacted-host>")
    .replace(/\bses_[a-z0-9_-]+\b/gi, "<redacted-session>")
    .replace(/\bsessionID\s*[=:]\s*[^\s,"']+/gi, "sessionID=<redacted>")
}

const capabilityEventTypes = new Set([
  "capability.activation.degraded",
  "capability.activation.failed",
  "capability.activation.requested",
  "capability.activation.succeeded",
  "capability.definitions.added",
  "capability.definitions.removed",
  "capability.loop.checkpoint.updated",
  "capability.loop.completion.requested",
  "capability.runtime.crashed",
  "capability.runtime.reused",
  "capability.runtime.started",
  "capability.runtime.stopped",
  "capability.schema.estimated",
  "capability.startup.measured",
])

function completionRate(results: ReadonlyArray<CaseScore>) {
  if (results.length === 0) return 0
  return results.filter((result) => result.completed).length / results.length
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.toSorted().every((value, index) => value === right.toSorted()[index])
}
