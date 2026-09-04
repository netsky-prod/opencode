import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260904125926_loop_checkpoint",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_loop\` ADD \`checkpoint_json\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
