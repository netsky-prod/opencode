import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createClient } from "@hey-api/openapi-ts"

test("flat SDK preserves required fields only when the body is required", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-required-body-"))
  try {
    for (const required of [true, false]) {
      const output = path.join(root, String(required))
      await createClient({
        input: {
          openapi: "3.1.0",
          info: { title: "Required body regression", version: "1" },
          paths: {
            "/callback": {
              post: {
                operationId: "auth.callback",
                requestBody: {
                  required,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          code: { type: "string" },
                          flowToken: { type: "string" },
                          optional: { type: "string" },
                        },
                        required: ["code", "flowToken"],
                      },
                    },
                  },
                },
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
        output,
        plugins: ["@hey-api/typescript", { name: "@hey-api/sdk", paramsStructure: "flat" }, "@hey-api/client-fetch"],
      })
      const sdk = await Bun.file(path.join(output, "sdk.gen.ts")).text()
      expect(/code\?: string/.test(sdk)).toBe(!required)
      expect(/flowToken\?: string/.test(sdk)).toBe(!required)
      expect(/optional\?: string/.test(sdk)).toBe(true)
      expect(/code: string/.test(sdk)).toBe(required)
      expect(/flowToken: string/.test(sdk)).toBe(required)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30000)
