export * as SkillGuidance from "./guidance"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { CapabilityCatalog } from "../capability/catalog"
import { CapabilityState } from "../capability/state"
import { PermissionV2 } from "../permission"
import { SessionSchema } from "../session/schema"
import { SkillV2 } from "../skill"
import { SystemContext } from "../system-context/index"

const Summary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})
type Summary = typeof Summary.Type

const render = (skills: ReadonlyArray<Summary>) =>
  [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    ...(skills.length === 0
      ? ["No skills are currently available."]
      : [
          "<available_skills>",
          ...skills.flatMap((skill) => [
            "  <skill>",
            `    <name>${skill.name}</name>`,
            `    <description>${skill.description}</description>`,
            "  </skill>",
          ]),
          "</available_skills>",
        ]),
  ].join("\n")

export interface Interface {
  readonly load: (sessionID: SessionSchema.ID, agent: AgentV2.Selection) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SkillGuidance") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* SkillV2.Service
    const capabilities = yield* CapabilityState.Service
    const catalog = yield* CapabilityCatalog.Service

    return Service.of({
      load: Effect.fn("SkillGuidance.load")(function* (sessionID, selection) {
        const agent = selection.info
        if (!agent) return SystemContext.empty
        const permitted = SkillV2.available(yield* listForSession({ sessionID, skills, capabilities, catalog }), agent)
        if (permitted.length === 0 && PermissionV2.evaluate("skill", "*", agent.permissions).effect === "deny")
          return SystemContext.empty
        const available = permitted
          .flatMap((skill) =>
            skill.description === undefined ? [] : [{ name: skill.name, description: skill.description }],
          )
          .toSorted((a, b) => a.name.localeCompare(b.name))
        return SystemContext.make({
          key: SystemContext.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          load: Effect.succeed(available),
          baseline: render,
          update: (_previous, current) =>
            [
              "The available skills have changed. This list supersedes the previous available skills list.",
              render(current),
            ].join("\n"),
          removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
        })
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [SkillV2.node, CapabilityState.node, CapabilityCatalog.node],
})

export const listForSession = Effect.fn("SkillGuidance.listForSession")(function* (input: {
  readonly sessionID: SessionSchema.ID
  readonly skills: SkillV2.Interface
  readonly capabilities: CapabilityState.Interface
  readonly catalog: CapabilityCatalog.Interface
}) {
  const available = new Map((yield* input.skills.list()).map((skill) => [skill.name, skill]))
  const activations = yield* input.capabilities.list(input.sessionID)
  for (const activation of activations) {
    const pack = yield* input.catalog.get(activation.id)
    if (!pack) continue
    const selected = new Set(
      activation.profiles.flatMap(
        (profile) => Object.entries(pack.profiles).find(([id]) => id === profile)?.[1].skills ?? [],
      ),
    )
    for (const skill of pack.skills) {
      if (!selected.has(skill.name) || skill.content === undefined || available.has(skill.name)) continue
      available.set(
        skill.name,
        SkillV2.Info.make({
          name: skill.name,
          description: skill.description,
          location: skill.location,
          content: skill.content,
        }),
      )
    }
  }
  return Array.from(available.values())
})
