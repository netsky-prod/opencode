import { CapabilityManager } from "@/capability/manager"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ManagerError } from "../groups/capability"

export const capabilityHandlers = HttpApiBuilder.group(InstanceHttpApi, "capability", (handlers) =>
  Effect.gen(function* () {
    const manager = yield* CapabilityManager.Service
    const error = (failure: { message: string }) => new ManagerError({ message: failure.message })
    return handlers
      .handle("list", (ctx) => manager.list(ctx.query.sessionID).pipe(Effect.mapError(error)))
      .handle("enable", (ctx) => manager.enable(ctx.payload).pipe(Effect.mapError(error)))
      .handle("disable", (ctx) => manager.disable(ctx.payload).pipe(Effect.mapError(error)))
      .handle("saveMcp", (ctx) => manager.saveMcp(ctx.payload).pipe(Effect.mapError(error)))
      .handle("checkMcp", (ctx) => manager.checkMcp(ctx.payload).pipe(Effect.mapError(error)))
      .handle("attachMcp", (ctx) => manager.attachMcp(ctx.payload).pipe(Effect.mapError(error)))
  }),
)
