export * as CapabilityTokenEstimate from "./token-estimate"

import type { ToolDefinition } from "@opencode-ai/llm"

const compareCodeUnits = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

export type Estimate = {
  readonly bytes: number
  readonly tokens: number
}

export type Comparison = {
  readonly baselineBytes: number
  readonly baselineTokens: number
  readonly activatedBytes: number
  readonly activatedTokens: number
  readonly deltaBytes: number
  readonly deltaTokens: number
}

/** Deterministic common provider representation; executable tool closures are never inspected. */
export const serialize = (definitions: ReadonlyArray<ToolDefinition>) =>
  JSON.stringify(
    definitions
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      }))
      .toSorted((left, right) => compareCodeUnits(left.name, right.name))
      .map(canonical),
  )

export const estimate = (definitions: ReadonlyArray<ToolDefinition>): Estimate => {
  const bytes = new TextEncoder().encode(serialize(definitions)).byteLength
  return { bytes, tokens: Math.ceil(bytes / 4) }
}

export const compare = (
  baseline: ReadonlyArray<ToolDefinition>,
  activated: ReadonlyArray<ToolDefinition>,
): Comparison => {
  const before = estimate(baseline)
  const after = estimate(activated)
  return {
    baselineBytes: before.bytes,
    baselineTokens: before.tokens,
    activatedBytes: after.bytes,
    activatedTokens: after.tokens,
    deltaBytes: after.bytes - before.bytes,
    deltaTokens: after.tokens - before.tokens,
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .toSorted(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => [key, canonical(item)]),
  )
}
