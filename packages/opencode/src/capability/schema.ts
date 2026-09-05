export * as CapabilitySchema from "./schema"

import { Schema } from "effect"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"

export const Scope = Schema.Literals(["global", "project"])
export const Exposure = Schema.Literals(["always-on", "pack-only"])
export const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/))
export const Patch = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("local"),
    command: Schema.optional(Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1))),
    cwd: Schema.optional(Schema.String),
    environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    enabled: Schema.optional(Schema.Boolean),
    timeout: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  Schema.Struct({
    type: Schema.Literal("remote"),
    url: Schema.optional(Schema.NonEmptyString),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    oauth: Schema.optional(Schema.Union([ConfigMCPV1.OAuth, Schema.Literal(false)])),
    enabled: Schema.optional(Schema.Boolean),
    timeout: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
])
export const Save = Schema.Struct({
  name: Name,
  scope: Scope,
  revision: Schema.String,
  config: Patch,
  exposure: Exposure,
  confirmExposureChange: Schema.optional(Schema.Boolean),
})
export const Attach = Schema.Struct({
  name: Name,
  mcpScope: Schema.optional(Scope),
  mcpRevision: Schema.String,
  scope: Scope,
  packID: Schema.String,
  profile: Schema.String,
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  revision: Schema.String,
  confirmExposureChange: Schema.optional(Schema.Boolean),
})
export const Mcp = Schema.Struct({
  name: Schema.String,
  scope: Scope,
  type: Schema.Literals(["local", "remote"]),
  exposure: Exposure,
  enabled: Schema.Boolean,
  revision: Schema.String,
  command: Schema.optional(Schema.Array(Schema.String)),
  url: Schema.optional(Schema.String),
  environmentKeys: Schema.Array(Schema.String),
  headerKeys: Schema.Array(Schema.String),
  status: Schema.String,
})
export const Check = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(["connected", "failed", "needs_auth"]),
  tools: Schema.Array(Schema.String),
  remediation: Schema.Array(Schema.String),
})
export const Attached = Schema.Struct({
  id: Schema.String,
  profile: Schema.String,
  reference: Schema.String,
  exposure: Schema.Literal("pack-only"),
})

export class Error extends Schema.TaggedErrorClass<Error>()("CapabilityManager.Error", { message: Schema.String }) {}
