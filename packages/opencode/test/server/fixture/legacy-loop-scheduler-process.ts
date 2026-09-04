import SQLite from "bun:sqlite"
import { Database } from "@opencode-ai/core/database/database"
import { z } from "zod"
import path from "node:path"
import { HttpApiApp } from "../../../src/server/routes/instance/httpapi/server"

const directory = process.argv[2]
const phase = process.argv[3] ?? "busy"
if (!directory) throw new Error("Missing test directory")

async function until(check: () => boolean, message: string) {
  const end = Date.now() + 10_000
  while (!check()) {
    if (Date.now() >= end) throw new Error(message)
    await Bun.sleep(20)
  }
}

async function main() {
  const requests: Record<string, unknown>[] = []
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = z.record(z.string(), z.unknown()).parse(await request.json())
      requests.push(body)
      const ordinal = requests.length
      if (ordinal === 1 && phase !== "resume") await held
      const text = ordinal === 1 && phase !== "resume" ? "FOREGROUND_REPLY_MARKER" : `SCHEDULED_REPLY_MARKER_${ordinal}`
      const events = [
        { id: "loop-test", choices: [{ delta: { role: "assistant", content: text } }] },
        {
          id: "loop-test",
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        },
      ]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  await Bun.write(
    path.join(directory, "opencode.json"),
    JSON.stringify({
      model: "loop-boundary/model",
      provider: {
        "loop-boundary": {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "stub-key", baseURL: `http://127.0.0.1:${provider.port}/v1` },
          models: {
            model: {
              name: "Loop boundary",
              tool_call: true,
              limit: { context: 32000, output: 2000 },
              modalities: { input: ["text"], output: ["text"] },
            },
          },
        },
      },
    }),
  )
  const context = HttpApiApp.context
  const call = (route: string, body: unknown) =>
    HttpApiApp.webHandler().handler(
      new Request(`http://localhost${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": directory },
        body: JSON.stringify(body),
      }),
      context,
    )
  const created = await call("/session", { title: "Legacy loop boundary" })
  if (created.status !== 200) throw new Error(`Create failed: ${created.status}`)
  const session = z.object({ id: z.string() }).parse(await created.json())
  const sqlite = new SQLite(Database.path())
  let foreground: Promise<string> | undefined
  try {
    if (phase === "resume") {
      const loop = z
        .object({ session_id: z.string(), pending_message_id: z.string() })
        .parse(sqlite.query("SELECT session_id, pending_message_id FROM session_loop WHERE id = 'loop_restart'").get())
      await until(() => requests.length === 1, "Persisted admitted wake did not resume after restart")
      const body = JSON.stringify(requests[0])
      if (body.includes("ORDINARY_QUEUE_ONLY_MARKER") || body.includes("TURN_LOCAL_ONLY_MARKER"))
        throw new Error("Loop inherited unrelated queued input or turn-local instructions")
      for (const marker of ["LEGACY_HISTORY_MARKER", "FOREGROUND_REPLY_MARKER", "SCHEDULED_WAKE_MARKER"]) {
        if (!body.includes(marker)) throw new Error(`Restart lost conversation history: ${marker}`)
      }
      await until(() => {
        const row = z
          .object({ pending_message_id: z.string().nullable(), last_admitted_at: z.number().nullable() })
          .parse(
            sqlite
              .query("SELECT pending_message_id, last_admitted_at FROM session_loop WHERE id = 'loop_restart'")
              .get(),
          )
        return row.pending_message_id === null && row.last_admitted_at !== null
      }, "Recovered input was not acknowledged/reconciled")
      const counts = z
        .object({ messages: z.number(), parts: z.number(), alternate: z.number(), promoted: z.number().nullable() })
        .parse(
          sqlite
            .query(
              `SELECT
        (SELECT count(*) FROM message WHERE id = ?) AS messages,
        (SELECT count(*) FROM part WHERE message_id = ?) AS parts,
        (SELECT count(*) FROM session_message WHERE session_id = ?) AS alternate,
        (SELECT promoted_seq FROM session_input WHERE id = ?) AS promoted`,
            )
            .get(loop.pending_message_id, loop.pending_message_id, loop.session_id, loop.pending_message_id),
        )
      if (counts.messages !== 1 || counts.parts !== 1 || counts.alternate !== 0 || counts.promoted === null)
        throw new Error(`Restart corrupted durable delivery: ${JSON.stringify(counts)}`)
      return
    }
    foreground = call(`/session/${session.id}/message`, {
      parts: [{ type: "text", text: "LEGACY_HISTORY_MARKER: continue this same conversation." }],
    }).then((response) => response.text())
    await until(() => requests.length > 0, "Foreground request did not start")
    const unrelated = await call(`/api/session/${session.id}/prompt`, {
      prompt: { text: "ORDINARY_QUEUE_ONLY_MARKER" },
      delivery: "queue",
      resume: false,
    })
    if (unrelated.status !== 200) throw new Error("Could not admit unrelated queue fixture")
    if (phase.startsWith("prepare-")) {
      release()
      await foreground
      const admitted = await call(`/api/session/${session.id}/prompt`, {
        prompt: { text: "SCHEDULED_WAKE_MARKER" },
        delivery: "queue",
        resume: false,
      })
      if (admitted.status !== 200) throw new Error(`Admission failed: ${admitted.status} ${await admitted.text()}`)
      const input = z.object({ data: z.object({ id: z.string() }) }).parse(await admitted.json())
      const now = Date.now()
      // Simulate the persisted projection at either crash boundary. The public
      // API above records real durable admission; no input or ACK is fabricated.
      if (phase !== "prepare-empty" && phase !== "prepare-retry") {
        const user = z
          .object({ data: z.string() })
          .parse(
            sqlite
              .query("SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' LIMIT 1")
              .get(session.id),
          )
        const prior = z
          .object({
            agent: z.string(),
            model: z.object({ providerID: z.string(), modelID: z.string(), variant: z.string().optional() }),
          })
          .passthrough()
          .parse(JSON.parse(user.data))
        const data = { role: "user", agent: prior.agent, model: prior.model, time: { created: now } }
        sqlite
          .query("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)")
          .run(input.data.id, session.id, now, now, JSON.stringify(data))
        if (phase === "prepare-full")
          sqlite
            .query("INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)")
            .run(
              `prt_loop_${input.data.id}`,
              input.data.id,
              session.id,
              now,
              now,
              JSON.stringify({ type: "text", text: "SCHEDULED_WAKE_MARKER" }),
            )
        // A changed prior turn must not invalidate already materialized identity.
        prior.model.variant = "changed-after-materialization"
        prior.system = "TURN_LOCAL_ONLY_MARKER"
        prior.format = { type: "json_schema", schema: { type: "object", properties: {} } }
        sqlite
          .query(
            "UPDATE message SET data = ? WHERE session_id = ? AND id <> ? AND json_extract(data, '$.role') = 'user'",
          )
          .run(JSON.stringify(prior), session.id, input.data.id)
      }
      sqlite
        .query(
          `INSERT INTO session_loop
        (id,session_id,prompt,mode,interval_ms,state,next_run_at,pending_message_id,failure_count,time_created,time_updated)
        VALUES ('loop_restart',?,?,'fixed',60000,'active',?,?,0,?,?)`,
        )
        .run(session.id, "SCHEDULED_WAKE_MARKER", now + 60000, input.data.id, now, now)
      if (phase === "prepare-retry")
        sqlite
          .query(
            "UPDATE session_loop SET failure_count = 1, last_error = 'earlier admission failure', lease_owner = 'crashed-retry', lease_expires_at = ? WHERE id = 'loop_restart'",
          )
          .run(now - 1)
      return
    }
    const now = Date.now()
    for (const ordinal of [1, 2]) {
      sqlite
        .query(
          `INSERT INTO session_loop
      (id,session_id,prompt,mode,interval_ms,state,next_run_at,failure_count,time_created,time_updated)
      VALUES (?,?,?,'fixed',60000,'active',?,0,?,?)`,
        )
        .run(`loop_legacy_boundary_${ordinal}`, session.id, `SCHEDULED_WAKE_MARKER_${ordinal}`, now - 1, now, now)
    }
    await until(() => {
      const rows = z
        .array(z.object({ last_admitted_at: z.number().nullable() }))
        .parse(sqlite.query("SELECT last_admitted_at FROM session_loop WHERE session_id = ?").all(session.id))
      return rows.length === 2 && rows.every((row) => row.last_admitted_at !== null)
    }, "Scheduled wake was not durably queued")
    const alternate = z
      .object({ count: z.number() })
      .parse(sqlite.query("SELECT count(*) AS count FROM session_message WHERE session_id = ?").get(session.id))
    if (alternate.count !== 0)
      throw new Error("Loop created an alternate Core conversation for an active legacy session")
    if (requests.length !== 1) throw new Error("Loop started a concurrent provider turn while foreground was busy")
    release()
    const firstResponse = await foreground
    if (!firstResponse.includes("FOREGROUND_REPLY_MARKER") || firstResponse.includes("SCHEDULED_REPLY_MARKER"))
      throw new Error("Scheduled wake replaced the foreground HTTP result")
    await until(() => requests.length >= 3, "Both queued wakes were not processed after the foreground turn")
    const second = JSON.stringify(requests[1])
    if (second.includes("ORDINARY_QUEUE_ONLY_MARKER")) throw new Error("Loop stole an unrelated queued prompt")
    for (const marker of ["LEGACY_HISTORY_MARKER", "FOREGROUND_REPLY_MARKER", "SCHEDULED_WAKE_MARKER"]) {
      if (!second.includes(marker)) throw new Error(`Wake omitted shared conversation evidence: ${marker}`)
    }
    if (second.includes("SCHEDULED_WAKE_MARKER_1") && second.includes("SCHEDULED_WAKE_MARKER_2"))
      throw new Error("Both queued inputs were promoted before one provider turn")
    const third = JSON.stringify(requests[2])
    for (const marker of ["SCHEDULED_WAKE_MARKER_1", "SCHEDULED_WAKE_MARKER_2", "SCHEDULED_REPLY_MARKER_2"]) {
      if (!third.includes(marker)) throw new Error(`Coalesced wake lost sequential history: ${marker}`)
    }
    await until(() => {
      const row = z
        .object({ count: z.number() })
        .parse(
          sqlite
            .query("SELECT count(*) AS count FROM session_loop WHERE session_id = ? AND pending_message_id IS NOT NULL")
            .get(session.id),
        )
      return row.count === 0
    }, "Queued inputs did not reconcile after promotion")
    const legacy = z
      .object({ count: z.number() })
      .parse(sqlite.query("SELECT count(*) AS count FROM message WHERE session_id = ?").get(session.id))
    if (legacy.count !== 6)
      throw new Error("Scheduled replies were not retained exactly once in the legacy conversation")
  } catch (error) {
    console.error(sqlite.query("SELECT id, last_error, failure_count FROM session_loop").all())
    throw error
  } finally {
    release()
    sqlite.close()
    void provider.stop(true)
  }
}

await main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
