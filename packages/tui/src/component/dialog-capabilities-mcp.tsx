import { createSignal, onMount } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogAlert } from "../ui/dialog-alert"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import {
  createMcpAttachInput,
  createMcpCheckInput,
  createMcpSaveInput,
  managerErrorMessage,
  mcpEffectiveNote,
  mcpServerDetails,
  mcpServerStatus,
  parseKeyList,
  parseLocalCommand,
  requiresMcpEditConfirmation,
  validateCapabilityName,
  validateMcpName,
  type McpDraft,
  type McpServerSummary,
} from "./dialog-capabilities-model"
import type { CapabilityManagerClient } from "./dialog-capabilities"
import type { CapabilityManagerInventory as Inventory } from "./dialog-capabilities-model"

export type McpAuthClient = {
  authenticate(input: { name: string }): Promise<{ data?: { status?: string }; error?: unknown }>
}

type Action = "setup" | "edit" | "check" | "auth" | "attach"

export function DialogMcpManager(props: {
  client: CapabilityManagerClient
  auth?: McpAuthClient
  inventory: Inventory
  mcp?: McpServerSummary
  sessionID?: string
}) {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [busy, setBusy] = createSignal(false)
  const options: DialogSelectOption<Action>[] = props.mcp
    ? [
        { value: "edit", title: "Edit configuration", description: "Blank connection fields preserve stored values" },
        { value: "check", title: "Check connection", description: "Probe health and list discovered tools" },
        ...(props.mcp.type === "remote"
          ? [{ value: "auth" as const, title: "Authenticate", description: "Start the remote MCP OAuth flow" }]
          : []),
        { value: "attach", title: "Attach to capability pack", description: "Reference this MCP from a user pack" },
      ]
    : [
        {
          value: "setup",
          title: "Set up MCP server",
          description: "Guided local-command or remote-URL configuration",
        },
      ]

  async function run(action: Action) {
    if (busy()) return
    if (action === "setup" || action === "edit") return editMcp(props, dialog, toast)
    const mcp = props.mcp
    if (!mcp) return
    setBusy(true)
    if (action === "check") {
      const result = await settle(props.client.checkMcp(createMcpCheckInput(mcp)))
      setBusy(false)
      if (result.error || !result.data) {
        toast.show({
          variant: "error",
          message: result.error ? managerErrorMessage(result.error, []) : "MCP check returned no result.",
        })
        return
      }
      await DialogAlert.show(
        dialog,
        `${mcp.name} connection`,
        [
          `State: ${result.data.state}`,
          `Tools: ${result.data.tools.length ? result.data.tools.join(", ") : "none"}`,
          ...(result.data.remediation.length ? [`Remediation: ${result.data.remediation.join("; ")}`] : []),
        ].join("\n"),
      )
      return
    }
    if (action === "auth") {
      if (!props.auth) {
        setBusy(false)
        toast.show({ variant: "error", message: "MCP authentication is unavailable." })
        return
      }
      const result = await settle(props.auth.authenticate({ name: mcp.name }))
      setBusy(false)
      if (result.error || !result.data) {
        toast.show({
          variant: "error",
          message: result.error ? managerErrorMessage(result.error, []) : "MCP authentication returned no result.",
        })
        return
      }
      toast.show({ variant: "success", message: `${mcp.name} authentication: ${result.data.status ?? "complete"}` })
      return
    }
    setBusy(false)
    await attachMcp({ ...props, mcp }, dialog, toast)
  }

  onMount(() => {
    if (!props.mcp) return
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={`${props.mcp ? `${props.mcp.name} MCP` : "Add MCP server"}${busy() ? " · working…" : ""}`}
      titleView={
        props.mcp ? (
          <text>
            <span style={{ fg: theme.text }}>
              <b>{props.mcp.name} MCP</b>
            </span>
            <span style={{ fg: theme.textMuted }}>
              {busy() ? " · working…" : ""} · {mcpServerStatus(props.mcp)}
            </span>
          </text>
        ) : undefined
      }
      options={options}
      locked={busy()}
      footer={
        props.mcp ? (
          <text fg={theme.textMuted}>
            {[...mcpServerDetails(props.mcp), mcpEffectiveNote(props.mcp, props.inventory.mcps)]
              .filter(Boolean)
              .join(" · ")}
          </text>
        ) : (
          <text fg={theme.textMuted}>Secrets are entered in concealed fields and never shown again.</text>
        )
      }
      onSelect={(option) => void run(option.value)}
    />
  )
}

async function editMcp(
  props: Parameters<typeof DialogMcpManager>[0],
  dialog: DialogContext,
  toast: ReturnType<typeof useToast>,
) {
  const nameInput =
    props.mcp?.name ?? (await DialogPrompt.show(dialog, "MCP server name", { placeholder: "server-name" }))
  if (nameInput === null) return
  const name = validateMcpName(nameInput)
  if (!name) return toast.show({ variant: "error", message: "Names may only contain letters, numbers, _ and -." })

  const type = props.mcp?.type ?? (await choose(dialog, "Connection type", ["local", "remote"] as const))
  if (!type) return
  const scope = props.mcp?.scope ?? (await choose(dialog, "Configuration scope", ["global", "project"] as const))
  if (!scope) return
  const exposure = await choose(dialog, "Tool exposure", ["always-on", "pack-only"] as const, props.mcp?.exposure)
  if (!exposure) return
  const enabled = await choose(
    dialog,
    "Connection",
    ["enabled", "disabled"] as const,
    props.mcp?.enabled === false ? "disabled" : "enabled",
  )
  if (!enabled) return

  const connection = await promptConnection(dialog, type, props.mcp)
  if (connection === null) return
  if (connection === false) {
    return toast.show({
      variant: "error",
      message: type === "local" ? "Command must be a non-empty JSON string array." : "URL must use HTTP or HTTPS.",
    })
  }
  if (!connection && !props.mcp) {
    return toast.show({ variant: "error", message: type === "local" ? "A command is required." : "A URL is required." })
  }

  const existingKeys = type === "local" ? (props.mcp?.environmentKeys ?? []) : (props.mcp?.headerKeys ?? [])
  const keyInput = await DialogPrompt.show(dialog, type === "local" ? "Environment keys" : "Header keys", {
    value: existingKeys.join(", "),
    placeholder: "Comma-separated names (optional)",
    description: () => <text>Names are visible; values are always concealed.</text>,
  })
  if (keyInput === null) return
  const keys = parseKeyList(keyInput)
  if (!keys) return toast.show({ variant: "error", message: "Credential names contain invalid characters." })

  const secrets: Record<string, string> = {}
  for (const key of keys) {
    const value = await DialogPrompt.show(dialog, key, {
      placeholder: existingKeys.includes(key) ? "Leave blank to preserve stored value" : "Secret value (optional)",
      secret: true,
      description: () => <text>Input concealed · blank preserves an existing value</text>,
    })
    if (value === null) return
    secrets[key] = value
  }

  const requiresConfirmation = requiresMcpEditConfirmation(props.mcp, exposure)
  if (requiresConfirmation) {
    const confirmed = await DialogConfirm.show(
      dialog,
      props.mcp?.exposure === exposure ? "Reconnect always-on MCP?" : "Change MCP exposure?",
      props.mcp?.exposure === exposure
        ? `${name} is always-on. Saving reconnects it in its current location and may affect active sessions.`
        : `${name} changes from ${props.mcp?.exposure} to ${exposure}; its available tools may change after the save.`,
    )
    if (confirmed !== true) return
  }

  const common = {
    name,
    scope,
    revision: props.mcp?.revision ?? props.inventory.configRevisions[scope],
    exposure,
    enabled: enabled === "enabled",
    secrets,
    confirmExposureChange: requiresConfirmation,
  }
  const draft: McpDraft =
    type === "local"
      ? { ...common, type, ...(connection ? { command: connection as string[] } : {}) }
      : { ...common, type, ...(connection ? { url: connection as string } : {}) }
  showWorking(dialog, `Saving ${name}`, "Saving MCP configuration…")
  const result = await settle(props.client.saveMcp(createMcpSaveInput(draft)))
  if (result.error || !result.data) {
    restoreManager(dialog, props)
    toast.show({
      variant: "error",
      message: result.error
        ? managerErrorMessage(result.error, Object.values(secrets))
        : "MCP configuration returned no result.",
    })
    return
  }
  toast.show({ variant: "success", message: `${name} configuration saved.` })
  dialog.clear()
}

async function promptConnection(dialog: DialogContext, type: "local" | "remote", existing?: McpServerSummary) {
  if (type === "local") {
    const value = await DialogPrompt.show(dialog, "Local command", {
      placeholder: existing ? "Leave blank to preserve the stored command" : '["executable", "arg"]',
      description: () => (
        <text>
          {existing?.command ? `Stored (redacted): ${JSON.stringify(existing.command)}` : "Enter a JSON string array."}
        </text>
      ),
    })
    if (value === null) return null
    if (!value.trim()) return undefined
    return parseLocalCommand(value) ?? false
  }
  const value = await DialogPrompt.show(dialog, "Remote URL", {
    placeholder: existing ? "Leave blank to preserve the stored URL" : "https://example.test/mcp",
    description: () => (
      <text>{existing?.url ? `Stored (redacted): ${existing.url}` : "HTTPS or HTTP MCP endpoint."}</text>
    ),
  })
  if (value === null) return null
  if (!value.trim()) return undefined
  return validRemoteUrl(value) ?? false
}

async function attachMcp(
  props: Parameters<typeof DialogMcpManager>[0] & { mcp: McpServerSummary },
  dialog: DialogContext,
  toast: ReturnType<typeof useToast>,
) {
  const selection = await selectValue<Inventory["packs"][number] | "new">(dialog, "Capability pack", [
    ...props.inventory.packs
      .filter((pack) => pack.source === "global" || pack.source === "project")
      .map((pack) => ({ title: pack.id, value: pack, description: pack.description })),
    { title: "Create new user pack", value: "new" as const, description: "Create a manifest that references this MCP" },
  ])
  if (!selection) return

  const packIDInput =
    selection === "new" ? await DialogPrompt.show(dialog, "New pack name", { placeholder: "team-tools" }) : selection.id
  if (packIDInput === null) return
  const packID = validateCapabilityName(packIDInput)
  if (!packID) return toast.show({ variant: "error", message: "Capability pack name is invalid." })
  const scope =
    selection === "new"
      ? await choose(dialog, "Pack storage scope", ["global", "project"] as const)
      : selection.source === "global"
        ? "global"
        : "project"
  if (!scope) return
  const description =
    selection === "new"
      ? await DialogPrompt.show(dialog, "Pack description", { placeholder: "Tools for this project" })
      : undefined
  if (description === null) return
  const profile =
    selection === "new"
      ? await DialogPrompt.show(dialog, "Profile name", { value: "default" })
      : selection.profiles.length > 1
        ? await selectValue(
            dialog,
            "Pack profile",
            selection.profiles.map((item) => ({ title: item.id, value: item.id, description: item.description })),
          )
        : (selection.profiles[0]?.id ?? "default")
  if (profile === null) return
  const normalizedProfile = validateCapabilityName(profile)
  if (!normalizedProfile) return toast.show({ variant: "error", message: "Capability profile name is invalid." })

  const confirmed =
    props.mcp.exposure !== "always-on" ||
    (await DialogConfirm.show(
      dialog,
      "Change global exposure?",
      `${props.mcp.name} is currently always-on. Attaching changes it to pack-only exposure to prevent duplicate tools.`,
    )) === true
  if (!confirmed) return

  showWorking(dialog, `Attaching ${props.mcp.name}`, "Updating capability pack…")
  const result = await settle(
    props.client.attachMcp(
      createMcpAttachInput({
        mcp: props.mcp,
        packID,
        profile: normalizedProfile,
        scope,
        description: description || undefined,
        packRevision: selection === "new" ? "" : selection.revision,
        confirmed,
      }),
    ),
  )
  if (result.error || !result.data) {
    restoreManager(dialog, props)
    toast.show({
      variant: "error",
      message: result.error ? managerErrorMessage(result.error, []) : "MCP attachment returned no result.",
    })
    return
  }
  toast.show({ variant: "success", message: `${props.mcp.name} attached to ${packID}/${normalizedProfile}.` })
  dialog.clear()
}

function showWorking(dialog: DialogContext, title: string, busyText: string) {
  dialog.replace(() => <DialogPrompt title={title} busy busyText={busyText} />)
}

function restoreManager(dialog: DialogContext, props: Parameters<typeof DialogMcpManager>[0]) {
  dialog.replace(() => <DialogMcpManager {...props} />)
}

function choose<const T extends string>(dialog: DialogContext, title: string, values: readonly T[], current?: T) {
  return selectValue(
    dialog,
    title,
    values.map((value) => ({ title: value, value })),
    current,
  )
}

function selectValue<T>(dialog: DialogContext, title: string, options: DialogSelectOption<T>[], current?: T) {
  return new Promise<T | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogSelect title={title} options={options} current={current} onSelect={(option) => resolve(option.value)} />
      ),
      () => resolve(null),
    )
  })
}

function validRemoteUrl(value: string) {
  return URL.parse(value)?.protocol.match(/^https?:$/) ? value : undefined
}

function settle<T>(promise: Promise<{ data?: T; error?: unknown }>) {
  return promise.then(
    (value) => value,
    (error) => ({ data: undefined, error }),
  )
}
