import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260828205201_session_loop",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_loop\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`mode\` text NOT NULL,
          \`interval_ms\` integer,
          \`state\` text NOT NULL,
          \`next_run_at\` integer,
          \`last_due_at\` integer,
          \`last_admitted_at\` integer,
          \`pending_message_id\` text,
          \`reason\` text,
          \`last_error\` text,
          \`failure_count\` integer DEFAULT 0 NOT NULL,
          \`lease_owner\` text,
          \`lease_expires_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_loop_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "session_loop_mode_interval_check" CHECK((mode = 'fixed' AND interval_ms IS NOT NULL) OR (mode = 'adaptive' AND interval_ms IS NULL)),
          CONSTRAINT "session_loop_state_next_check" CHECK((state = 'active' AND next_run_at IS NOT NULL) OR (state != 'active' AND next_run_at IS NULL))
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_loop_due_idx\` ON \`session_loop\` (\`state\`,\`next_run_at\`);`)
      yield* tx.run(`CREATE INDEX \`session_loop_session_state_idx\` ON \`session_loop\` (\`session_id\`,\`state\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_loop_pending_message_idx\` ON \`session_loop\` (\`pending_message_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
