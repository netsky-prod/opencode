export * as CapabilityEvent from "./event"

import { Cause, Clock, Effect, Exit, Schema } from "effect"
import { EventV2 } from "../event"
import { NonNegativeInt } from "../schema"

const PublicID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const DiagnosticRef = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

const ActivationRequested = EventV2.define({
  type: "capability.activation.requested",
  schema: { capabilityID: PublicID },
})
const ActivationSucceeded = EventV2.define({
  type: "capability.activation.succeeded",
  schema: {
    capabilityID: PublicID,
    state: Schema.Literal("active"),
    durationMs: NonNegativeInt,
    runtimeCount: NonNegativeInt,
  },
})
const ActivationDegraded = EventV2.define({
  type: "capability.activation.degraded",
  schema: {
    capabilityID: PublicID,
    state: Schema.Literal("degraded"),
    durationMs: NonNegativeInt,
    runtimeCount: NonNegativeInt,
  },
})
const ActivationFailed = EventV2.define({
  type: "capability.activation.failed",
  schema: {
    capabilityID: PublicID,
    state: Schema.Literals(["failed", "unsupported", "interrupted"]),
    durationMs: NonNegativeInt,
    runtimeCount: NonNegativeInt,
    diagnosticRef: DiagnosticRef,
  },
})
const RuntimeStarted = EventV2.define({
  type: "capability.runtime.started",
  schema: {
    runtimeID: PublicID,
    state: Schema.Literals(["healthy", "degraded"]),
    durationMs: NonNegativeInt,
    referenceCount: NonNegativeInt,
  },
})
const RuntimeReused = EventV2.define({
  type: "capability.runtime.reused",
  schema: {
    runtimeID: PublicID,
    state: Schema.Literals(["healthy", "degraded"]),
    referenceCount: NonNegativeInt,
  },
})
const RuntimeStopped = EventV2.define({
  type: "capability.runtime.stopped",
  schema: {
    runtimeID: PublicID,
    state: Schema.Literal("stopped"),
    durationMs: NonNegativeInt,
    referenceCount: NonNegativeInt,
  },
})
const RuntimeCrashed = EventV2.define({
  type: "capability.runtime.crashed",
  schema: {
    runtimeID: PublicID,
    state: Schema.Literal("failed"),
    referenceCount: NonNegativeInt,
    diagnosticRef: DiagnosticRef,
  },
})
const DefinitionsAdded = EventV2.define({
  type: "capability.definitions.added",
  schema: { count: NonNegativeInt },
})
const DefinitionsRemoved = EventV2.define({
  type: "capability.definitions.removed",
  schema: { count: NonNegativeInt },
})
const CheckpointUpdated = EventV2.define({
  type: "capability.loop.checkpoint.updated",
  schema: {
    loopID: PublicID,
    state: Schema.Literals(["active", "paused", "completed"]),
    factCount: NonNegativeInt,
    evidenceCount: NonNegativeInt,
    artifactCount: NonNegativeInt,
    blockerCount: NonNegativeInt,
  },
})
const CompletionRequested = EventV2.define({
  type: "capability.loop.completion.requested",
  schema: { loopID: PublicID, state: Schema.Literal("completed") },
})
const StartupMeasured = EventV2.define({
  type: "capability.startup.measured",
  schema: {
    capabilityID: PublicID,
    state: Schema.Literals(["active", "degraded", "failed", "unsupported"]),
    durationMs: NonNegativeInt,
    runtimeCount: NonNegativeInt,
  },
})
const SchemaEstimated = EventV2.define({
  type: "capability.schema.estimated",
  schema: {
    state: Schema.Literals(["baseline", "active"]),
    definitionCount: NonNegativeInt,
    baselineBytes: NonNegativeInt,
    baselineTokens: NonNegativeInt,
    activatedBytes: NonNegativeInt,
    activatedTokens: NonNegativeInt,
    deltaBytes: Schema.Int,
    deltaTokens: Schema.Int,
  },
})

export const Event = {
  Activation: {
    Requested: ActivationRequested,
    Succeeded: ActivationSucceeded,
    Degraded: ActivationDegraded,
    Failed: ActivationFailed,
  },
  Runtime: {
    Started: RuntimeStarted,
    Reused: RuntimeReused,
    Stopped: RuntimeStopped,
    Crashed: RuntimeCrashed,
  },
  Definitions: { Added: DefinitionsAdded, Removed: DefinitionsRemoved },
  Loop: { CheckpointUpdated, CompletionRequested },
  StartupMeasured,
  SchemaEstimated,
} as const

export type Input =
  | { readonly type: "capability.activation.requested"; readonly capabilityID: string }
  | {
      readonly type: "capability.activation.succeeded"
      readonly capabilityID: string
      readonly state: "active"
      readonly durationMs: number
      readonly runtimeCount: number
    }
  | {
      readonly type: "capability.activation.degraded"
      readonly capabilityID: string
      readonly state: "degraded"
      readonly durationMs: number
      readonly runtimeCount: number
    }
  | {
      readonly type: "capability.activation.failed"
      readonly capabilityID: string
      readonly state: "failed" | "unsupported" | "interrupted"
      readonly durationMs: number
      readonly runtimeCount: number
      readonly diagnosticRef: string
    }
  | {
      readonly type: "capability.runtime.started"
      readonly runtimeID: string
      readonly state: "healthy" | "degraded"
      readonly durationMs: number
      readonly referenceCount: number
    }
  | {
      readonly type: "capability.runtime.reused"
      readonly runtimeID: string
      readonly state: "healthy" | "degraded"
      readonly referenceCount: number
    }
  | {
      readonly type: "capability.runtime.stopped"
      readonly runtimeID: string
      readonly state: "stopped"
      readonly durationMs: number
      readonly referenceCount: number
    }
  | {
      readonly type: "capability.runtime.crashed"
      readonly runtimeID: string
      readonly state: "failed"
      readonly referenceCount: number
      readonly diagnosticRef: string
    }
  | { readonly type: "capability.definitions.added"; readonly count: number }
  | { readonly type: "capability.definitions.removed"; readonly count: number }
  | {
      readonly type: "capability.loop.checkpoint.updated"
      readonly loopID: string
      readonly state: "active" | "paused" | "completed"
      readonly factCount: number
      readonly evidenceCount: number
      readonly artifactCount: number
      readonly blockerCount: number
    }
  | { readonly type: "capability.loop.completion.requested"; readonly loopID: string; readonly state: "completed" }
  | {
      readonly type: "capability.startup.measured"
      readonly capabilityID: string
      readonly state: "active" | "degraded" | "failed" | "unsupported"
      readonly durationMs: number
      readonly runtimeCount: number
    }
  | {
      readonly type: "capability.schema.estimated"
      readonly state: "baseline" | "active"
      readonly definitionCount: number
      readonly baselineBytes: number
      readonly baselineTokens: number
      readonly activatedBytes: number
      readonly activatedTokens: number
      readonly deltaBytes: number
      readonly deltaTokens: number
    }

export const publish = (events: EventV2.Interface, input: Input) =>
  publishAllowed(events, input).pipe(
    Effect.timeoutOrElse({ duration: "100 millis", orElse: () => Effect.void }),
    Effect.catchCause(() => Effect.void),
    Effect.uninterruptible,
  )

export const observeActivation = <A extends { readonly state: "active" | "degraded" | "failed" | "unsupported" }, E, R>(
  events: EventV2.Interface,
  input: { readonly capabilityID: string; readonly runtimeCount: number | (() => number) },
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    yield* publish(events, { type: "capability.activation.requested", capabilityID: input.capabilityID })
    return yield* operation.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const durationMs = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt)
          const state = Exit.isSuccess(exit)
            ? exit.value.state
            : Cause.hasInterrupts(exit.cause)
              ? ("interrupted" as const)
              : ("failed" as const)
          const runtimeCount = typeof input.runtimeCount === "function" ? input.runtimeCount() : input.runtimeCount
          yield* publish(events, {
            type: "capability.startup.measured",
            capabilityID: input.capabilityID,
            state: state === "interrupted" ? "failed" : state,
            durationMs,
            runtimeCount,
          })
          if (state === "active") {
            yield* publish(events, {
              type: "capability.activation.succeeded",
              capabilityID: input.capabilityID,
              state,
              durationMs,
              runtimeCount,
            })
            return
          }
          if (state === "degraded") {
            yield* publish(events, {
              type: "capability.activation.degraded",
              capabilityID: input.capabilityID,
              state,
              durationMs,
              runtimeCount,
            })
            return
          }
          yield* publish(events, {
            type: "capability.activation.failed",
            capabilityID: input.capabilityID,
            state,
            durationMs,
            runtimeCount,
            diagnosticRef: Exit.isSuccess(exit)
              ? state === "unsupported"
                ? "activation-unsupported"
                : "activation-rejected"
              : state === "interrupted"
                ? "activation-interrupted"
                : "activation-error",
          })
        }),
      ),
    )
  })

function publishAllowed(events: EventV2.Interface, input: Input): Effect.Effect<void> {
  const publish = <D extends EventV2.Definition>(definition: D, data: EventV2.Data<D>) =>
    events.publish(definition, data, { location: false }).pipe(Effect.asVoid)
  switch (input.type) {
    case "capability.activation.requested":
      return publish(ActivationRequested, { capabilityID: input.capabilityID })
    case "capability.activation.succeeded":
      return publish(ActivationSucceeded, {
        capabilityID: input.capabilityID,
        state: input.state,
        durationMs: input.durationMs,
        runtimeCount: input.runtimeCount,
      })
    case "capability.activation.degraded":
      return publish(ActivationDegraded, {
        capabilityID: input.capabilityID,
        state: input.state,
        durationMs: input.durationMs,
        runtimeCount: input.runtimeCount,
      })
    case "capability.activation.failed":
      return publish(ActivationFailed, {
        capabilityID: input.capabilityID,
        state: input.state,
        durationMs: input.durationMs,
        runtimeCount: input.runtimeCount,
        diagnosticRef: input.diagnosticRef,
      })
    case "capability.runtime.started":
      return publish(RuntimeStarted, {
        runtimeID: input.runtimeID,
        state: input.state,
        durationMs: input.durationMs,
        referenceCount: input.referenceCount,
      })
    case "capability.runtime.reused":
      return publish(RuntimeReused, {
        runtimeID: input.runtimeID,
        state: input.state,
        referenceCount: input.referenceCount,
      })
    case "capability.runtime.stopped":
      return publish(RuntimeStopped, {
        runtimeID: input.runtimeID,
        state: input.state,
        durationMs: input.durationMs,
        referenceCount: input.referenceCount,
      })
    case "capability.runtime.crashed":
      return publish(RuntimeCrashed, {
        runtimeID: input.runtimeID,
        state: input.state,
        referenceCount: input.referenceCount,
        diagnosticRef: input.diagnosticRef,
      })
    case "capability.definitions.added":
      return publish(DefinitionsAdded, { count: input.count })
    case "capability.definitions.removed":
      return publish(DefinitionsRemoved, { count: input.count })
    case "capability.loop.checkpoint.updated":
      return publish(CheckpointUpdated, {
        loopID: input.loopID,
        state: input.state,
        factCount: input.factCount,
        evidenceCount: input.evidenceCount,
        artifactCount: input.artifactCount,
        blockerCount: input.blockerCount,
      })
    case "capability.loop.completion.requested":
      return publish(CompletionRequested, { loopID: input.loopID, state: input.state })
    case "capability.startup.measured":
      return publish(StartupMeasured, {
        capabilityID: input.capabilityID,
        state: input.state,
        durationMs: input.durationMs,
        runtimeCount: input.runtimeCount,
      })
    case "capability.schema.estimated":
      return publish(SchemaEstimated, {
        state: input.state,
        definitionCount: input.definitionCount,
        baselineBytes: input.baselineBytes,
        baselineTokens: input.baselineTokens,
        activatedBytes: input.activatedBytes,
        activatedTokens: input.activatedTokens,
        deltaBytes: input.deltaBytes,
        deltaTokens: input.deltaTokens,
      })
  }
}
