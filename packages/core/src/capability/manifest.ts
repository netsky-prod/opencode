export * as CapabilityManifest from "./manifest"

import path from "path"
import { Effect, Schema } from "effect"
import { ConfigMCP } from "../config/mcp"
import { PositiveInt } from "../schema"

const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export const ID = Schema.String.check(Schema.isPattern(idPattern)).pipe(Schema.brand("CapabilityManifest.ID"))
export type ID = typeof ID.Type

export const Skill = Schema.Struct({
  name: ID,
  description: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
})
export type Skill = typeof Skill.Type

export const Runtime = Schema.Struct({
  id: ID,
  type: Schema.Literals(["mcp", "cli"]),
  command: Schema.Array(Schema.NonEmptyString),
  // Upstream MCP names are discovered by the adapter, which must canonicalize them and reject collisions then.
  // `tools` covers only manifest-owned names known at decode time.
  tools: Schema.Array(Schema.NonEmptyString).pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed([]))),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optional: Schema.Boolean.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(false))),
  timeoutMs: PositiveInt.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(15_000))),
})
export type Runtime = typeof Runtime.Type

export const Profile = Schema.Struct({
  description: Schema.NonEmptyString,
  skills: Schema.Array(ID),
  runtimes: Schema.Array(ID),
})
export type Profile = typeof Profile.Type

export const Dependency = Schema.Struct({
  id: ID,
  check: Schema.Array(Schema.NonEmptyString),
  optional: Schema.Boolean.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(false))),
})
export type Dependency = typeof Dependency.Type

export const Permissions = Schema.Struct({
  servers: Schema.optional(Schema.Record(ID, ConfigMCP.Server)),
})
export type Permissions = typeof Permissions.Type

export const Manifest = Schema.Struct({
  id: ID,
  version: Schema.Literal(1),
  description: Schema.NonEmptyString,
  platforms: Schema.Array(Schema.Literals(["darwin", "linux"])),
  skills: Schema.Array(Skill),
  runtimes: Schema.Array(Runtime),
  profiles: Schema.Record(ID, Profile),
  dependencies: Schema.optional(Schema.Array(Dependency)),
  permissions: Schema.optional(Permissions),
})
export type Manifest = typeof Manifest.Type

export const canonicalName = (pack: string, runtime: string, upstream: string) => `${pack}_${runtime}_${upstream}`

export const decode = (input: unknown) =>
  Schema.decodeUnknownEffect(Manifest)(input, { onExcessProperty: "error", errors: "all" }).pipe(
    Effect.flatMap((manifest) => Effect.try({ try: () => validate(manifest), catch: (cause) => cause })),
  )

function validate(manifest: Manifest) {
  if (Object.keys(manifest.profiles).length === 0) throw new Error("Capability manifests require at least one profile")

  const skills = new Set<string>()
  for (const skill of manifest.skills) {
    if (skills.has(skill.name)) throw new Error(`Duplicate skill ID: ${skill.name}`)
    if (!isContainedPath(skill.path)) throw new Error(`Skill path escapes the manifest: ${skill.path}`)
    skills.add(skill.name)
  }

  const runtimes = new Set<string>()
  const names = new Set<string>()
  for (const runtime of manifest.runtimes) {
    if (runtimes.has(runtime.id)) throw new Error(`Duplicate runtime ID: ${runtime.id}`)
    runtimes.add(runtime.id)
    for (const tool of runtime.tools ?? []) {
      const name = canonicalName(manifest.id, runtime.id, tool)
      if (names.has(name)) throw new Error(`Canonical tool name collision: ${name}`)
      names.add(name)
    }
  }

  const dependencies = new Set<string>()
  for (const dependency of manifest.dependencies ?? []) {
    if (dependencies.has(dependency.id)) throw new Error(`Duplicate dependency ID: ${dependency.id}`)
    dependencies.add(dependency.id)
  }

  for (const [id, profile] of Object.entries(manifest.profiles)) {
    for (const skill of profile.skills) {
      if (!skills.has(skill)) throw new Error(`Profile ${id} references unknown skill: ${skill}`)
    }
    for (const runtime of profile.runtimes) {
      if (!runtimes.has(runtime)) throw new Error(`Profile ${id} references unknown runtime: ${runtime}`)
    }
  }
  return manifest
}

function isContainedPath(value: string) {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !URL.canParse(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  )
}
