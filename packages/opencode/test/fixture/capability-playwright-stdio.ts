import { appendFileSync } from "node:fs"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const screenshot = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
)
let current: { readonly url: string; readonly body: string } | undefined
let marked = false

function markClosed() {
  if (marked) return
  marked = true
  const marker = process.env.OPENCODE_TEST_BROWSER_CLOSE_MARKER
  if (marker) appendFileSync(marker, "closed\n")
}

process.once("exit", markClosed)
process.once("SIGTERM", () => {
  markClosed()
  process.exit(0)
})

const server = new Server({ name: "playwright-fixture", version: "0.0.80" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      {
        name: "browser_navigate",
        description: "Navigate to a URL",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
          additionalProperties: false,
        },
      },
      {
        name: "browser_snapshot",
        description: "Inspect the current page",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "browser_take_screenshot",
        description: "Save a screenshot",
        inputSchema: {
          type: "object",
          properties: { filename: { type: "string" } },
          required: ["filename"],
          additionalProperties: false,
        },
      },
    ],
  }),
)
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const input = request.params.arguments ?? {}
  let structuredContent: Readonly<Record<string, unknown>>
  if (request.params.name === "browser_navigate") {
    const url = String(input.url)
    current = { url, body: await fetch(url).then((response) => response.text()) }
    structuredContent = { url, status: 200 }
  } else if (request.params.name === "browser_snapshot") {
    structuredContent = { url: current?.url, text: current?.body }
  } else {
    const filename = String(input.filename)
    await Bun.write(filename, screenshot)
    structuredContent = { path: filename, url: current?.url }
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  }
})

await server.connect(new StdioServerTransport())
