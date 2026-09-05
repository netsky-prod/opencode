import { expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

cliIt.live("Netsky uninstall leaves compatible OpenCode state untouched", ({ home, opencode }) =>
  Effect.gen(function* () {
    const uninstall = yield* Effect.promise(() => import("../../src/cli/cmd/uninstall"))
    const legacy = path.join(home, ".local/share/opencode/session.json")
    yield* Effect.promise(() => Bun.write(legacy, '{"session":"preserved"}\n'))

    const result = yield* opencode.spawn(["uninstall", "--dry-run", "--force"])
    const collectRemovalTargets = (
      uninstall as unknown as {
        collectRemovalTargets?: (
          args: { dryRun: boolean; force: boolean },
          method: "unknown",
        ) => Promise<{ directories: unknown[] }>
      }
    ).collectRemovalTargets

    opencode.expectExit(result, 0, "netsky uninstall --dry-run")
    expect(result.stderr).toContain("Netsky Code")
    expect(collectRemovalTargets).toBeFunction()
    if (!collectRemovalTargets) return
    const targets = yield* Effect.promise(() => collectRemovalTargets({ dryRun: true, force: true }, "unknown"))
    expect(targets.directories).toEqual([])
    expect(yield* Effect.promise(() => Bun.file(legacy).text())).toBe('{"session":"preserved"}\n')
  }),
)
