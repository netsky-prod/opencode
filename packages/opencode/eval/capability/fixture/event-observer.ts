import fs from "fs/promises"

export const CapabilityEvalEventObserver = async () => ({
  event: async ({ event }: { event: { type: string; properties: unknown } }) => {
    if (!event.type.startsWith("capability.")) return
    const target = process.env.CAPABILITY_EVAL_EVENT_FILE
    if (!target) return
    await fs.appendFile(target, `${JSON.stringify({ type: event.type, data: event.properties })}\n`, "utf8")
  },
})
