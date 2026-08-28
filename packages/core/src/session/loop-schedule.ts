export const MIN_DELAY_MS = 10_000
export const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1_000
export const ADAPTIVE_FALLBACK_MS = 10 * 60 * 1_000

const units = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const

export function parseDelay(value: string) {
  const match = /^([1-9]\d*)(s|m|h|d)$/.exec(value.trim())
  if (!match) throw new Error("Duration must be one positive integer followed by s, m, h, or d")

  const result = Number(match[1]) * units[match[2] as keyof typeof units]
  if (!Number.isSafeInteger(result) || result < MIN_DELAY_MS || result > MAX_DELAY_MS) {
    throw new Error("Duration must be between 10s and 7d")
  }
  return result
}

export function nextFixedBoundary(previousDue: number, intervalMs: number, now: number) {
  if (intervalMs < MIN_DELAY_MS || intervalMs > MAX_DELAY_MS) throw new Error("Invalid loop interval")
  return previousDue + (Math.floor(Math.max(0, now - previousDue) / intervalMs) + 1) * intervalMs
}

export function initialNextRun(mode: "fixed" | "adaptive", now: number, intervalMs?: number) {
  if (mode === "adaptive") return now
  if (intervalMs === undefined) throw new Error("Fixed loops require an interval")
  return now + intervalMs
}
