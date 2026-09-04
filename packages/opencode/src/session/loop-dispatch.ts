export * as SessionLoopHostDispatch from "./loop-dispatch"

import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionLoopDispatch } from "@opencode-ai/core/session/loop-dispatch"
import { SessionLoop } from "@opencode-ai/core/session/loop"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "./prompt"

export const node = makeGlobalNode({
  service: SessionLoopDispatch.Service,
  layer: Layer.effect(
    SessionLoopDispatch.Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const prompts = yield* SessionPrompt.Service
      const instances = yield* InstanceStore.Service
      const loops = yield* SessionLoop.Service
      const prompt: SessionLoopDispatch.Interface["prompt"] = Effect.fn("SessionLoopHostDispatch.prompt")(
        function* (input) {
          const legacy = yield* database.db
            .select({ id: MessageTable.id })
            .from(MessageTable)
            .where(eq(MessageTable.session_id, input.sessionID))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!legacy) return yield* sessions.prompt(input)
          const session = yield* sessions.get(input.sessionID)
          const admitted = yield* sessions.prompt({ ...input, resume: false })
          if (admitted.promotedSeq === undefined)
            yield* instances
              .provide({ directory: session.location.directory }, prompts.wakeQueued(input.sessionID))
              .pipe(Effect.provideService(WorkspaceRef, session.location.workspaceID))
          return admitted
        },
      )
      return SessionLoopDispatch.Service.of({
        prompt,
        recover: SessionLoopDispatch.recover(database.db, loops, prompt),
      })
    }),
  ),
  deps: [Database.node, SessionV2.node, SessionPrompt.node, InstanceStore.node, SessionLoop.node],
})
