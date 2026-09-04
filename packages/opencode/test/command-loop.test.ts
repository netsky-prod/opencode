import { describe, expect, test } from "bun:test"
import { Command } from "../src/command"

describe("built-in loop command", () => {
  test("advertises arguments and operations", () => {
    expect(Command.Default.LOOP).toBe("loop")
    expect(Command.hints(Command.LOOP_TEMPLATE)).toEqual(["$ARGUMENTS"])
    for (const tool of ["loop_create", "loop_list", "loop_update", "loop_checkpoint", "loop_delete", "loop_wakeup"]) {
      expect(Command.LOOP_TEMPLATE).toContain(tool)
    }
    for (const form of ["/loop <duration> <prompt>", "/loop <prompt>", "/loop <duration>", "/loop -- <prompt>"]) {
      expect(Command.LOOP_TEMPLATE).toContain(form)
    }
  })
})
