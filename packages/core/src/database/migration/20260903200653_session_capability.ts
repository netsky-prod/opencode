import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260903200653_session_capability",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_capability\` (
          \`session_id\` text NOT NULL,
          \`capability_id\` text NOT NULL,
          \`profiles_json\` text NOT NULL,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_capability_pk\` PRIMARY KEY(\`session_id\`, \`capability_id\`),
          CONSTRAINT \`fk_session_capability_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
