import { CapabilitySchema } from "@/capability/schema"
import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { CapabilityTool } from "@opencode-ai/core/tool/capability"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"

export class ManagerError extends Schema.ErrorClass<ManagerError>("CapabilityManagerError")(
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export const List = Schema.Struct({
  packs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      description: Schema.String,
      source: Schema.Literals(["builtin", "global", "project", "unavailable"]),
      revision: Schema.String,
      profiles: Schema.Array(
        Schema.Struct({ id: Schema.String, description: Schema.String, platforms: Schema.Array(Schema.String) }),
      ),
      active: Schema.Boolean,
      selectedProfiles: Schema.Array(Schema.String),
      state: Schema.String,
      remediation: Schema.Array(Schema.String),
    }),
  ),
  mcps: Schema.Array(CapabilitySchema.Mcp),
  configRevisions: Schema.Struct({ global: Schema.String, project: Schema.String }),
})

export const CapabilityApi = HttpApi.make("capability").add(
  HttpApiGroup.make("capability")
    .add(
      HttpApiEndpoint.get("list", "/capability", {
        query: Schema.Struct({ ...WorkspaceRoutingQueryFields, sessionID: Schema.optional(SessionSchema.ID) }),
        success: List,
        error: ManagerError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "capability.list",
          summary: "List capability packs and configured MCP servers",
        }),
      ),
      HttpApiEndpoint.post("enable", "/capability/enable", {
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({
          sessionID: SessionSchema.ID,
          id: CapabilityManifest.ID,
          profiles: Schema.optional(Schema.Array(CapabilityManifest.ID).check(Schema.isMaxLength(16))),
        }),
        success: CapabilityTool.EnableOutput,
        error: ManagerError,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "capability.enable", summary: "Enable a capability directly for a session" }),
      ),
      HttpApiEndpoint.post("disable", "/capability/disable", {
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({ sessionID: SessionSchema.ID, id: CapabilityManifest.ID }),
        success: Schema.Struct({ id: Schema.String, state: Schema.Literal("disabled"), nextTurn: Schema.Boolean }),
        error: ManagerError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "capability.disable",
          summary: "Disable a capability directly for a session",
        }),
      ),
      HttpApiEndpoint.post("saveMcp", "/capability/mcp", {
        query: WorkspaceRoutingQuery,
        payload: CapabilitySchema.Save,
        success: CapabilitySchema.Mcp,
        error: ManagerError,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "capability.saveMcp", summary: "Persist a scoped MCP configuration patch" }),
      ),
      HttpApiEndpoint.post("checkMcp", "/capability/mcp/check", {
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({ name: CapabilitySchema.Name, scope: Schema.optional(CapabilitySchema.Scope) }),
        success: CapabilitySchema.Check,
        error: ManagerError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "capability.checkMcp",
          summary: "Check a configured MCP using an isolated connection",
        }),
      ),
      HttpApiEndpoint.post("attachMcp", "/capability/mcp/attach", {
        query: WorkspaceRoutingQuery,
        payload: CapabilitySchema.Attach,
        success: CapabilitySchema.Attached,
        error: ManagerError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "capability.attachMcp",
          summary: "Attach a configured MCP by reference to a user capability pack",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
