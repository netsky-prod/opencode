export * as LoopTool from "./loop"

import { ToolFailure } from "@opencode-ai/llm"
import { Clock, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionLoop } from "../session/loop"
import { parseDelay } from "../session/loop-schedule"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"

export const names = ["loop_create", "loop_list", "loop_update", "loop_delete", "loop_wakeup"] as const

export const CreateInput = Schema.Struct({
  prompt: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
  schedule: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("fixed"), every: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("adaptive") }),
  ]),
  reason: Schema.optional(Schema.String),
})

export const UpdateInput = Schema.Struct({
  id: SessionLoop.ID,
  prompt: Schema.optional(Schema.String),
  every: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Literals(["active", "paused", "completed"])),
  reason: Schema.optional(Schema.String),
})

export const WakeupInput = Schema.Union([
  Schema.Struct({
    id: SessionLoop.ID,
    action: Schema.Literal("schedule"),
    in: Schema.String,
    reason: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
  }),
  Schema.Struct({
    id: SessionLoop.ID,
    action: Schema.Literals(["pause", "complete"]),
    reason: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
  }),
])

const ListInput = Schema.Struct({})
const DeleteInput = Schema.Struct({ id: SessionLoop.ID })
const Output = Schema.Struct({ message: Schema.String })

function summary(loop: SessionLoop.Info) {
  const next = loop.nextRunAt === undefined ? "none" : new Date(loop.nextRunAt).toLocaleString()
  return [
    `Loop ${loop.id}`,
    `state: ${loop.state}`,
    `mode: ${loop.mode}`,
    `next: ${next}`,
    `prompt: ${loop.prompt}`,
    loop.reason ? `reason: ${loop.reason}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

const toModelOutput = ({ output }: { output: { message: string } }) => [{ type: "text" as const, text: output.message }]

const parse = (value: string) =>
  Effect.try({
    try: () => parseDelay(value),
    catch: () => new ToolFailure({ message: "Invalid loop duration" }),
  })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const loops = yield* SessionLoop.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        loop_create: Tool.make({
          description: "Create a durable fixed or adaptive loop for the current session.",
          input: CreateInput,
          output: Output,
          toModelOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: "loop",
                resources: ["new"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const intervalMs = input.schedule.kind === "fixed" ? yield* parse(input.schedule.every) : undefined
              const loop = yield* loops.create({
                sessionID: context.sessionID,
                prompt: input.prompt,
                mode: input.schedule.kind,
                intervalMs,
                reason: input.reason,
              })
              return { message: summary(loop) }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to create loop" }))),
        }),
        loop_list: Tool.make({
          description: "List durable loops owned by the current session.",
          input: ListInput,
          output: Output,
          toModelOutput,
          execute: (_input, context) =>
            loops.list(context.sessionID).pipe(
              Effect.map((items) => ({ message: items.length === 0 ? "No loops" : items.map(summary).join("\n\n") })),
              Effect.mapError(() => new ToolFailure({ message: "Unable to list loops" })),
            ),
        }),
        loop_update: Tool.make({
          description: "Update the prompt, cadence, state, or reason of a durable loop.",
          input: UpdateInput,
          output: Output,
          toModelOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: "loop",
                resources: [input.id],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const intervalMs = input.every === undefined ? undefined : yield* parse(input.every)
              const loop = yield* loops.update({
                sessionID: context.sessionID,
                id: input.id,
                prompt: input.prompt,
                intervalMs,
                state: input.state,
                reason: input.reason,
              })
              return { message: summary(loop) }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to update loop" }))),
        }),
        loop_delete: Tool.make({
          description: "Delete a durable loop owned by the current session.",
          input: DeleteInput,
          output: Output,
          toModelOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: "loop",
                resources: [input.id],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const pending = yield* loops.remove({ sessionID: context.sessionID, id: input.id })
              return {
                message: pending
                  ? `Deleted ${input.id}; one already admitted prompt may still run.`
                  : `Deleted ${input.id}.`,
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to delete loop" }))),
        }),
        loop_wakeup: Tool.make({
          description: "Choose the next wake-up, pause, or completion state for an adaptive loop.",
          input: WakeupInput,
          output: Output,
          toModelOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: "loop",
                resources: [input.id],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const now = yield* Clock.currentTimeMillis
              const loop =
                input.action === "schedule"
                  ? yield* loops.update({
                      sessionID: context.sessionID,
                      id: input.id,
                      state: "active",
                      nextRunAt: now + (yield* parse(input.in)),
                      reason: input.reason,
                      now,
                    })
                  : yield* loops.update({
                      sessionID: context.sessionID,
                      id: input.id,
                      state: input.action === "pause" ? "paused" : "completed",
                      reason: input.reason,
                      now,
                    })
              return { message: summary(loop) }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to update loop wake-up" }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/loop",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionLoop.node],
})
