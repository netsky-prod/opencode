import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { runFixtureOutcome } from "./outcome"
import fs from "fs/promises"
import path from "path"

const caseID = process.env.CAPABILITY_EVAL_CASE
const root = process.env.CAPABILITY_EVAL_ROOT
if (!caseID || !root) throw new Error("Capability evaluation fixture environment is required")

const server = new Server({ name: "capability-eval-outcome", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    ...(caseID === "missing-dependency-recovery"
      ? [
          {
            name: "repair_dependency",
            description: "Install the disposable fixture dependency so default activation can be retried.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ]
      : []),
    {
      name: "verify_outcome",
      description: `Execute the deterministic ${caseID} fixture outcome and preserve external evidence.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "repair_dependency" && caseID === "missing-dependency-recovery") {
    await fs.writeFile(path.join(root, ".eval", "dependency-ready"), "ready\n")
    return { content: [{ type: "text", text: "Dependency installed; retry default activation." }] }
  }
  if (request.params.name !== "verify_outcome") throw new Error("Unknown fixture tool")
  return { content: [{ type: "text", text: await runFixtureOutcome(caseID, root) }] }
})

await server.connect(new StdioServerTransport())
