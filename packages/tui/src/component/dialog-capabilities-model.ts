import type {
  CapabilityDisableResponses,
  CapabilityEnableResponses,
  CapabilityListResponses,
  CapabilitySaveMcpData,
} from "@opencode-ai/sdk/v2"

export type CapabilityManagerInventory = CapabilityListResponses[200]
export type CapabilityPackSummary = CapabilityManagerInventory["packs"][number]
export type McpServerSummary = CapabilityManagerInventory["mcps"][number]

export type McpDraft = {
  name: string
  scope: "global" | "project"
  revision: string
  exposure: "always-on" | "pack-only"
  enabled: boolean
  secrets: Record<string, string>
  confirmExposureChange?: boolean
} & ({ type: "local"; command?: string[] } | { type: "remote"; url?: string })

type CapabilityActivationClient = {
  enable(input: {
    sessionID: string
    id: string
    profiles?: string[]
  }): Promise<{ data?: CapabilityEnableResponses[200]; error?: unknown }>
  disable(input: {
    sessionID: string
    id: string
  }): Promise<{ data?: CapabilityDisableResponses[200]; error?: unknown }>
}

export function capabilityPackStatus(pack: CapabilityPackSummary) {
  return [pack.active ? "active" : "inactive", ...(pack.active ? pack.selectedProfiles : []), pack.state].join(" · ")
}

export function capabilityPackDetails(pack: CapabilityPackSummary) {
  return [pack.description, ...pack.remediation.map((item) => `Remediation: ${item}`)]
}

export function canChangeCapabilityActivation(pack: CapabilityPackSummary, profiles: string[]) {
  return pack.active || profiles.length > 0
}

export function validateCapabilityName(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(normalized)) return
  return normalized
}

export function validateMcpName(value: string) {
  const normalized = value.trim()
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(normalized)) return
  return normalized
}

export function parseLocalCommand(value: string) {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed) || parsed.length === 0) return
  if (!parsed.every((part) => typeof part === "string" && part.length > 0)) return
  return parsed
}

export function parseKeyList(value: string) {
  const result = [
    ...new Set(
      value
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ]
  if (!result.every((key) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key))) return
  return result
}

export function createMcpSaveInput(draft: McpDraft): NonNullable<CapabilitySaveMcpData["body"]> {
  const secrets = Object.fromEntries(Object.entries(draft.secrets).filter(([, value]) => value.length > 0))
  const common = {
    name: draft.name,
    scope: draft.scope,
    revision: draft.revision,
    exposure: draft.exposure,
    ...(draft.confirmExposureChange ? { confirmExposureChange: true } : {}),
  }
  if (draft.type === "local") {
    return {
      ...common,
      config: {
        type: draft.type,
        ...(draft.command ? { command: draft.command } : {}),
        enabled: draft.enabled,
        ...(Object.keys(secrets).length ? { environment: secrets } : {}),
      },
    }
  }
  return {
    ...common,
    config: {
      type: draft.type,
      ...(draft.url ? { url: draft.url } : {}),
      enabled: draft.enabled,
      ...(Object.keys(secrets).length ? { headers: secrets } : {}),
    },
  }
}

export function managerErrorMessage(error: unknown, secrets: string[]) {
  const message =
    error instanceof Error
      ? error.message
      : isRecord(error) && isRecord(error.data) && typeof error.data.message === "string"
        ? error.data.message
        : isRecord(error) && typeof error.message === "string"
          ? error.message
          : "Capability operation failed"
  return secrets.filter(Boolean).reduce((result, secret) => result.replaceAll(secret, "[redacted]"), message)
}

export function mcpServerStatus(server: McpServerSummary) {
  const status =
    server.enabled && server.status === "disabled"
      ? server.exposure === "pack-only"
        ? "on demand"
        : "not started"
      : server.status.replaceAll("_", " ")
  return [server.scope, server.exposure, server.enabled ? "enabled" : "disabled", status].join(" · ")
}

export function mcpServerDetails(server: McpServerSummary) {
  return [
    ...(server.command ? [`Local: ${JSON.stringify(server.command)}`] : []),
    ...(server.url ? [`Remote: ${server.url}`] : []),
    ...(server.environmentKeys.length
      ? [`Environment: ${server.environmentKeys.map((key) => `${key}=••••`).join(", ")}`]
      : []),
    ...(server.headerKeys.length ? [`Headers: ${server.headerKeys.map((key) => `${key}=••••`).join(", ")}`] : []),
  ]
}

export function createMcpCheckInput(server: McpServerSummary) {
  return { name: server.name, scope: server.scope }
}

export function mcpEffectiveNote(_server: McpServerSummary, _servers: McpServerSummary[]) {
  const duplicate = _servers.some((candidate) => candidate.name === _server.name && candidate.scope !== _server.scope)
  if (!duplicate) return
  return _server.scope === "global"
    ? "Project override is effective by name; this global entry's scoped check or attach may reject."
    : "This project definition is effective by name."
}

export function requiresMcpEditConfirmation(server: McpServerSummary | undefined, exposure: McpDraft["exposure"]) {
  return !!server && (server.exposure === "always-on" || server.exposure !== exposure)
}

export async function changeCapabilityActivation(input: {
  client: CapabilityActivationClient
  sessionID?: string
  id: string
  profiles: string[]
  active: boolean
}) {
  if (!input.sessionID) return { ok: false, message: "Select a session before activating a capability pack." } as const
  if (input.active) {
    const result = await input.client
      .enable({
        sessionID: input.sessionID,
        id: input.id,
        ...(input.profiles.length ? { profiles: input.profiles } : {}),
      })
      .then(
        (value) => value,
        (error) => ({ data: undefined, error }),
      )
    if (result.error) return { ok: false, message: managerErrorMessage(result.error, []) } as const
    if (!result.data) return { ok: false, message: "Capability operation returned no result." } as const
    if (result.data.state === "failed" || result.data.state === "unsupported") {
      const remediation = result.data.remediation.length ? ` ${result.data.remediation.join(" ")}` : ""
      return {
        ok: false,
        message: `Capability ${input.id} could not activate (${result.data.state}).${remediation}`,
      } as const
    }
    return {
      ok: true,
      ...(result.data.state === "degraded" && result.data.remediation.length
        ? { warning: result.data.remediation.join(" ") }
        : {}),
    } as const
  }
  const result = await input.client.disable({ sessionID: input.sessionID, id: input.id }).then(
    (value) => value,
    (error) => ({ data: undefined, error }),
  )
  if (result.error) return { ok: false, message: managerErrorMessage(result.error, []) } as const
  if (!result.data) return { ok: false, message: "Capability operation returned no result." } as const
  return { ok: true } as const
}

export function createMcpAttachInput(input: {
  mcp: McpServerSummary
  packID: string
  profile: string
  scope: "global" | "project"
  description?: string
  packRevision: string
  confirmed: boolean
}) {
  return {
    name: input.mcp.name,
    scope: input.scope,
    mcpScope: input.mcp.scope,
    packID: input.packID,
    profile: input.profile,
    ...(input.description ? { description: input.description } : {}),
    revision: input.packRevision,
    mcpRevision: input.mcp.revision,
    ...(input.mcp.exposure === "always-on" && input.confirmed ? { confirmExposureChange: true } : {}),
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
