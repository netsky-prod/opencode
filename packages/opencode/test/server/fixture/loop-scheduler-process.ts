import { Database as SQLite } from "bun:sqlite"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { Context } from "effect"
import path from "path"
import { HttpApiApp } from "../../../src/server/routes/instance/httpapi/server"

const directory = process.argv[2]
if (!directory) throw new Error("Missing test directory")

const expectedKey = process.env.SCHEDULED_BRIDGE_API_KEY
if (!expectedKey) throw new Error("Missing scheduled bridge test credential")
let providerRequest:
  | {
      authorization: string | null
      body: Record<string, unknown>
    }
  | undefined
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    const authorization = request.headers.get("authorization")
    const body = (await request.json()) as Record<string, unknown>
    providerRequest = { authorization, body }
    if (authorization !== `Bearer ${expectedKey}`) {
      return Response.json({ error: { message: "invalid test API key" } }, { status: 401 })
    }
    const events = [
      { id: "chatcmpl-scheduled", choices: [{ delta: { role: "assistant" } }] },
      { id: "chatcmpl-scheduled", choices: [{ delta: { content: "scheduled provider turn completed" } }] },
      {
        id: "chatcmpl-scheduled",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      },
    ]
    return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})

await Bun.write(
  path.join(directory, "opencode.json"),
  JSON.stringify({
    model: "scheduled-bridge/bridge-model",
    provider: {
      "scheduled-bridge": {
        name: "Scheduled bridge",
        npm: "@ai-sdk/openai-compatible",
        options: {
          apiKey: "{env:SCHEDULED_BRIDGE_API_KEY}",
          baseURL: `http://127.0.0.1:${provider.port}/v1`,
        },
        models: {
          "bridge-model": {
            id: "bridge-model",
            name: "Bridge model",
            release_date: "2026-01-01",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            limit: { context: 32_000, output: 2_000 },
            cost: { input: 0, output: 0 },
            modalities: { input: ["text"], output: ["text"] },
            options: {},
          },
        },
      },
    },
  }),
)

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
  sqlite
    .query(
      `INSERT INTO session_loop
        (id, session_id, prompt, mode, state, next_run_at, checkpoint_json,
         failure_count, time_created, time_updated)
       VALUES (?, ?, ?, 'adaptive', 'active', ?, ?, 0, ?, ?)`,
    )
    .run(
      "loop_ambient_context_test",
      session.data.id,
      "Companion work not present in the scheduled wake prompt",
      now + 60_000,
      JSON.stringify({
        objective: "AMBIENT_CONTEXT_ONLY_MARKER",
        acceptanceCriteria: [],
        verifiedFacts: [{ claim: "Ambient checkpoint persisted", evidence: ["test://ambient-context"] }],
        observations: [],
        inferences: [],
        assumptions: [],
        decisions: [],
        blockers: [],
        artifacts: ["/tmp/ambient-context.txt"],
        nextAction: "Keep companion loop active",
        updatedAt: now,
      }),
      now,
      now,
    )

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

  const providerDeadline = Date.now() + 5_000
  while (!providerRequest && Date.now() < providerDeadline) await Bun.sleep(20)
  if (!providerRequest) throw new Error("Scheduled resume never reached the configured provider")
  if (providerRequest.authorization !== `Bearer ${expectedKey}`) {
    throw new Error("Scheduled resume did not resolve its configured provider credential")
  }
  if (providerRequest.body.model !== "bridge-model") {
    throw new Error(`Scheduled resume used the wrong model: ${String(providerRequest.body.model)}`)
  }
  if (!JSON.stringify(providerRequest.body).includes("Continue integration test")) {
    throw new Error("Scheduled resume omitted the persisted loop prompt")
  }
  const messages = providerRequest.body.messages
  const ambient =
    Array.isArray(messages) &&
    Array.isArray(messages) &&
    messages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "system" &&
        JSON.stringify(message).includes("AMBIENT_CONTEXT_ONLY_MARKER"),
    )
  if (!ambient) throw new Error("Scheduled resume omitted ambient SessionLoopContext from provider system parts")
  if (
    messages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "user" &&
        JSON.stringify(message).includes("AMBIENT_CONTEXT_ONLY_MARKER"),
    )
  ) {
    throw new Error("Ambient SessionLoopContext marker leaked into the scheduled user wake")
  }
  const tools = providerRequest.body.tools
  const wake =
    Array.isArray(tools) &&
    tools.find(
      (tool) =>
        typeof tool === "object" &&
        tool !== null &&
        "function" in tool &&
        typeof tool.function === "object" &&
        tool.function !== null &&
        "name" in tool.function &&
        tool.function.name === "loop_wakeup",
    )
  const schema =
    wake && typeof wake === "object" && "function" in wake && wake.function && typeof wake.function === "object"
      ? "parameters" in wake.function
        ? wake.function.parameters
        : undefined
      : undefined
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Scheduled resume omitted the loop_wakeup provider schema")
  }
  const root = schema as Record<string, unknown>
  const properties = root.properties as Record<string, unknown> | undefined
  const required = root.required
  const action = properties?.action as Record<string, unknown> | undefined
  if (
    root.type !== "object" ||
    root.anyOf !== undefined ||
    root.oneOf !== undefined ||
    !properties?.id ||
    !properties.action ||
    !properties.in ||
    !properties.reason ||
    !properties.checkpoint
  ) {
    throw new Error(`loop_wakeup provider schema is not one flat object: ${JSON.stringify(schema)}`)
  }
  if (
    !Array.isArray(required) ||
    !["id", "action", "reason"].every((field) => required.includes(field)) ||
    JSON.stringify(action?.enum) !== JSON.stringify(["schedule", "pause", "complete"])
  ) {
    throw new Error(`loop_wakeup provider schema lost its required fields or action enum: ${JSON.stringify(schema)}`)
  }

  const assistantDeadline = Date.now() + 5_000
  let assistant: { data: string } | undefined
  while (Date.now() < assistantDeadline) {
    assistant = sqlite
      .query("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC")
      .all(session.data.id)[0] as { data: string } | undefined
    if (assistant) break
    await Bun.sleep(20)
  }
  if (!assistant) throw new Error("Scheduled provider failure was not durably observable")
  const data = JSON.parse(assistant.data) as { error?: unknown; finish?: string }
  if (data.error) throw new Error(`Scheduled provider turn failed: ${JSON.stringify(data.error)}`)
  if (data.finish !== "stop") throw new Error(`Scheduled provider turn did not finish: ${String(data.finish)}`)
} finally {
  sqlite.close()
  provider.stop(true)
}

process.exit(0)
