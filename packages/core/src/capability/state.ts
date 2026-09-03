export * as CapabilityState from "./state"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"
import { SessionCapabilityTable } from "../session/sql"
import { CapabilityCatalog } from "./catalog"

export type State = "active" | "degraded"

export type Activation = {
  readonly id: string
  readonly profiles: ReadonlyArray<string>
  readonly state: State
}

export type Status = Activation | (Omit<Activation, "state"> & { readonly state: "unavailable" })

export type EnableInput = {
  readonly sessionID: SessionSchema.ID
  readonly id: string
  readonly profiles: ReadonlyArray<string>
  readonly state?: State
}

export class ManifestNotFoundError extends Schema.TaggedErrorClass<ManifestNotFoundError>()(
  "CapabilityState.ManifestNotFoundError",
  { id: Schema.String },
) {
  override get message() {
    return `Capability manifest not found: ${this.id}`
  }
}

export class ProfileNotFoundError extends Schema.TaggedErrorClass<ProfileNotFoundError>()(
  "CapabilityState.ProfileNotFoundError",
  { id: Schema.String, profile: Schema.String },
) {
  override get message() {
    return `Capability profile not found: ${this.id}/${this.profile}`
  }
}

export interface Interface {
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Activation>>
  readonly enable: (input: EnableInput) => Effect.Effect<void, ManifestNotFoundError | ProfileNotFoundError>
  readonly disable: (input: { readonly sessionID: SessionSchema.ID; readonly id: string }) => Effect.Effect<void>
  readonly status: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Status>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CapabilityState") {}

export const make = (input: { readonly db: Database.Interface["db"]; readonly catalog: CapabilityCatalog.Interface }): Interface => {
  const list = Effect.fn("CapabilityState.list")(function* (sessionID: SessionSchema.ID) {
    const rows = yield* input.db
      .select()
      .from(SessionCapabilityTable)
      .where(eq(SessionCapabilityTable.session_id, sessionID))
      .orderBy(asc(SessionCapabilityTable.capability_id))
      .all()
      .pipe(Effect.orDie)
    return rows.map((row): Activation => ({
      id: row.capability_id,
      profiles: profiles(row.profiles_json),
      state: row.state,
    }))
  })

  const enable = Effect.fn("CapabilityState.enable")(function* (value: EnableInput) {
    const pack = yield* input.catalog.get(value.id)
    if (!pack) return yield* new ManifestNotFoundError({ id: value.id })
    const selected = [...new Set(value.profiles)].toSorted()
    const missing = selected.find((profile) => !(profile in pack.profiles))
    if (missing) return yield* new ProfileNotFoundError({ id: value.id, profile: missing })
    const now = Date.now()
    yield* input.db
      .transaction((tx) =>
        tx
          .insert(SessionCapabilityTable)
          .values({
            session_id: value.sessionID,
            capability_id: value.id,
            profiles_json: JSON.stringify(selected),
            state: value.state ?? "active",
            time_created: now,
            time_updated: now,
          })
          .onConflictDoUpdate({
            target: [SessionCapabilityTable.session_id, SessionCapabilityTable.capability_id],
            set: { profiles_json: JSON.stringify(selected), state: value.state ?? "active", time_updated: now },
          })
          .run(),
      )
      .pipe(Effect.orDie)
  })

  const disable = Effect.fn("CapabilityState.disable")(function* (value: { readonly sessionID: SessionSchema.ID; readonly id: string }) {
    yield* input.db
      .transaction((tx) =>
        tx
          .delete(SessionCapabilityTable)
          .where(and(eq(SessionCapabilityTable.session_id, value.sessionID), eq(SessionCapabilityTable.capability_id, value.id)))
          .run(),
      )
      .pipe(Effect.orDie)
  })

  const status = Effect.fn("CapabilityState.status")(function* (sessionID: SessionSchema.ID) {
    const active = yield* list(sessionID)
    return yield* Effect.forEach(active, (activation) =>
      input.catalog.get(activation.id).pipe(
        Effect.map((pack): Status => (pack ? activation : { ...activation, state: "unavailable" })),
      ),
    )
  })

  return Service.of({ list, enable, disable, status })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const catalog = yield* CapabilityCatalog.Service
    return make({ db, catalog })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [CapabilityCatalog.node, Database.node] })

function profiles(value: string): ReadonlyArray<string> {
  const decoded = JSON.parse(value)
  if (!Array.isArray(decoded) || decoded.some((profile) => typeof profile !== "string")) {
    throw new Error("Invalid persisted capability profiles")
  }
  return decoded
}
