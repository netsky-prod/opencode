import { describe, expect, test } from "bun:test"
import { ToolDefinition } from "@opencode-ai/llm"
import { CapabilityTokenEstimate } from "@opencode-ai/core/capability/token-estimate"

const tool = (input: {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}) => new ToolDefinition(input)

describe("CapabilityTokenEstimate", () => {
  test("canonically serializes the provider-visible schema independent of object and tool order", () => {
    const left = [
      tool({ name: "zeta", description: "later", inputSchema: { type: "object", properties: {} } }),
      tool({
        name: "alpha",
        description: "é",
        inputSchema: {
          required: ["z"],
          properties: { z: { type: "number" }, a: { type: "string" } },
          type: "object",
        },
      }),
    ]
    const right = [
      tool({
        name: "alpha",
        description: "é",
        inputSchema: {
          type: "object",
          properties: { a: { type: "string" }, z: { type: "number" } },
          required: ["z"],
        },
      }),
      tool({ name: "zeta", description: "later", inputSchema: { properties: {}, type: "object" } }),
    ]
    const expected =
      '[{"description":"é","inputSchema":{"properties":{"a":{"type":"string"},"z":{"type":"number"}},"required":["z"],"type":"object"},"name":"alpha"},{"description":"later","inputSchema":{"properties":{},"type":"object"},"name":"zeta"}]'

    expect(CapabilityTokenEstimate.serialize(left)).toBe(expected)
    expect(CapabilityTokenEstimate.serialize(right)).toBe(expected)
    expect(CapabilityTokenEstimate.estimate(left)).toEqual({
      bytes: new TextEncoder().encode(expected).byteLength,
      tokens: Math.ceil(new TextEncoder().encode(expected).byteLength / 4),
    })
  })

  test("uses locale-independent UTF-16 code-unit ordering for non-ASCII schema keys", () => {
    const definitions = [
      tool({
        name: "ä-tool",
        description: "unicode",
        inputSchema: {
          type: "object",
          properties: { ä: { type: "string" }, z: { type: "number" }, A: { type: "boolean" } },
        },
      }),
      tool({ name: "z-tool", description: "ascii", inputSchema: { type: "object" } }),
    ]

    expect(CapabilityTokenEstimate.serialize(definitions)).toBe(
      '[{"description":"ascii","inputSchema":{"type":"object"},"name":"z-tool"},{"description":"unicode","inputSchema":{"properties":{"A":{"type":"boolean"},"z":{"type":"number"},"ä":{"type":"string"}},"type":"object"},"name":"ä-tool"}]',
    )
  })

  test("reports hand-derived baseline and activated totals without reading non-schema fields", () => {
    const baseline = [tool({ name: "base", description: "b", inputSchema: { type: "object" } })]
    const activated = [
      ...baseline,
      tool({ name: "extra", description: "x", inputSchema: { properties: {}, type: "object" } }),
    ]
    const baseText = '[{"description":"b","inputSchema":{"type":"object"},"name":"base"}]'
    const activeText =
      '[{"description":"b","inputSchema":{"type":"object"},"name":"base"},{"description":"x","inputSchema":{"properties":{},"type":"object"},"name":"extra"}]'
    const baseBytes = new TextEncoder().encode(baseText).byteLength
    const activeBytes = new TextEncoder().encode(activeText).byteLength

    expect(CapabilityTokenEstimate.compare(baseline, activated)).toEqual({
      baselineBytes: baseBytes,
      baselineTokens: Math.ceil(baseBytes / 4),
      activatedBytes: activeBytes,
      activatedTokens: Math.ceil(activeBytes / 4),
      deltaBytes: activeBytes - baseBytes,
      deltaTokens: Math.ceil(activeBytes / 4) - Math.ceil(baseBytes / 4),
    })
  })
})
