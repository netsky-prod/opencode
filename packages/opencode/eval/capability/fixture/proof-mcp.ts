import fs from "fs/promises"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "capability-eval-proof", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "write_proof",
      description: "Write the exact requested proof text to the externally verified evaluation artifact.",
      inputSchema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
        additionalProperties: false,
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const target = process.env.CAPABILITY_EVAL_PROOF_FILE
  if (!target) throw new Error("CAPABILITY_EVAL_PROOF_FILE is required")
  const content = request.params.arguments?.content
  if (typeof content !== "string") throw new Error("content must be a string")
  await fs.writeFile(target, content, "utf8")
  return { content: [{ type: "text", text: "Proof artifact written and ready for external verification." }] }
})

await server.connect(new StdioServerTransport())
