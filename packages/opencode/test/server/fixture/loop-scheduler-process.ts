import { Database as SQLite } from "bun:sqlite"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { Context } from "effect"
import { HttpApiApp } from "../../../src/server/routes/instance/httpapi/server"

const directory = process.argv[2]
if (!directory) throw new Error("Missing test directory")

const context = Context.empty() as Context.Context<unknown>
const response = await HttpApiApp.webHandler().handler(
  new Request("http://localhost/api/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-directory": directory,
    },
    body: JSON.stringify({ location: { directory } }),
  }),
  context,
)
if (response.status !== 200) throw new Error(`Session creation failed: ${response.status} ${await response.text()}`)
const session = (await response.json()) as { data: { id: string } }

const sqlite = new SQLite(CoreDatabase.path())
try {
  const now = Date.now()
  sqlite
    .query(
      `INSERT INTO session_loop
        (id, session_id, prompt, mode, interval_ms, state, next_run_at,
         failure_count, time_created, time_updated)
       VALUES (?, ?, ?, 'fixed', ?, 'active', ?, 0, ?, ?)`,
    )
    .run("loop_server_test", session.data.id, "Continue integration test", 10_000, now - 1, now, now)

  const deadline = Date.now() + 5_000
  let admitted: { id: string; delivery: string } | undefined
  while (Date.now() < deadline) {
    admitted = sqlite.query("SELECT id, delivery FROM session_input WHERE session_id = ?").all(session.data.id)[0] as
      | { id: string; delivery: string }
      | undefined
    if (admitted) break
    await Bun.sleep(20)
  }
  if (!admitted) throw new Error("Scheduler did not admit queued input")
  if (admitted.delivery !== "queue") throw new Error(`Unexpected delivery: ${admitted.delivery}`)

  await Bun.sleep(1_200)
  const count = sqlite
    .query("SELECT count(*) AS count FROM session_input WHERE session_id = ?")
    .get(session.data.id) as { count: number }
  if (count.count !== 1) throw new Error(`Expected one admitted input, received ${count.count}`)
} finally {
  sqlite.close()
}

process.exit(0)
