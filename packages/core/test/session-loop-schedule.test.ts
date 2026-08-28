import { describe, expect, test } from "bun:test"
import {
  ADAPTIVE_FALLBACK_MS,
  initialNextRun,
  nextFixedBoundary,
  parseDelay,
} from "@opencode-ai/core/session/loop-schedule"

describe("loop schedule", () => {
  test.each([
    ["10s", 10_000],
    ["5m", 300_000],
    ["2h", 7_200_000],
    ["7d", 604_800_000],
  ])("parses %s", (input, expected) => expect(parseDelay(input)).toBe(expected))

  test.each(["9s", "8d", "1.5m", "10 minutes", "1h30m", "", "-1m"])("rejects %s", (input) => {
    expect(() => parseDelay(input)).toThrow()
  })

  test("coalesces missed boundaries", () => {
    expect(nextFixedBoundary(100_000, 60_000, 100_001)).toBe(160_000)
    expect(nextFixedBoundary(100_000, 60_000, 399_999)).toBe(400_000)
    expect(nextFixedBoundary(100_000, 60_000, 400_000)).toBe(460_000)
  })

  test("creates initial wake-ups", () => {
    expect(initialNextRun("fixed", 1_000, 60_000)).toBe(61_000)
    expect(initialNextRun("adaptive", 1_000)).toBe(1_000)
    expect(ADAPTIVE_FALLBACK_MS).toBe(600_000)
  })
})
