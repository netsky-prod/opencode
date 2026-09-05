import { createMemo, createSignal, onMount, Show } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import {
  capabilityPackDetails,
  capabilityPackStatus,
  canChangeCapabilityActivation,
  changeCapabilityActivation,
  managerErrorMessage,
  mcpEffectiveNote,
  mcpServerDetails,
  mcpServerStatus,
  type CapabilityManagerInventory,
  type CapabilityPackSummary,
  type McpServerSummary,
} from "./dialog-capabilities-model"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { DialogMcpManager, type McpAuthClient } from "./dialog-capabilities-mcp"
import type {
  CapabilityAttachMcpData,
  CapabilityCheckMcpResponses,
  CapabilityDisableResponses,
  CapabilityEnableResponses,
  CapabilitySaveMcpData,
} from "@opencode-ai/sdk/v2"

type ManagerResponse<T> = Promise<{ data?: T; error?: unknown }>

export type CapabilityManagerClient = {
  list(input: { sessionID?: string }): ManagerResponse<CapabilityManagerInventory>
  enable(input: { sessionID: string; id: string; profiles?: string[] }): ManagerResponse<CapabilityEnableResponses[200]>
  disable(input: { sessionID: string; id: string }): ManagerResponse<CapabilityDisableResponses[200]>
  saveMcp(input: NonNullable<CapabilitySaveMcpData["body"]>): ManagerResponse<unknown>
  checkMcp(input: { name: string; scope: "global" | "project" }): ManagerResponse<CapabilityCheckMcpResponses[200]>
  attachMcp(input: NonNullable<CapabilityAttachMcpData["body"]>): ManagerResponse<unknown>
}

type Selection =
  | { kind: "pack"; pack: CapabilityPackSummary }
  | { kind: "mcp"; mcp: McpServerSummary }
  | { kind: "add-mcp" }
  | { kind: "retry" }

export function capabilityManagerCommands(open: () => void) {
  return [
    {
      name: "capability.list",
      title: "Manage capabilities and MCPs",
      category: "Agent",
      slashName: "capabilities",
      run: open,
    },
    {
      name: "mcp.list",
      title: "Manage MCP servers",
      category: "Agent",
      slashName: "mcps",
      run: open,
    },
  ]
}

export function DialogCapabilitiesView(props: {
  client: CapabilityManagerClient
  auth?: McpAuthClient
  sessionID?: string
}) {
  const dialog = useDialog()
  const [inventory, setInventory] = createSignal<CapabilityManagerInventory>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)

  async function refresh() {
    setLoading(true)
    setError(undefined)
    await props.client.list(props.sessionID ? { sessionID: props.sessionID } : {}).then(
      (result) => {
        if (result.error) {
          setError(managerErrorMessage(result.error, []))
          return
        }
        if (!result.data) {
          setError("Capability inventory returned no result.")
          return
        }
        setInventory(result.data)
      },
      (failure) => setError(managerErrorMessage(failure, [])),
    )
    setLoading(false)
  }

  onMount(() => void refresh())

  const options = createMemo<DialogSelectOption<Selection>[]>(() => {
    if (loading()) return []
    if (error()) {
      return [
        {
          value: { kind: "retry" },
          title: "Retry inventory",
          description: error(),
          category: "Error",
        },
      ]
    }
    const data = inventory()
    if (!data) return []
    return [
      ...data.packs.map((pack) => ({
        value: { kind: "pack" as const, pack },
        title: pack.id,
        description: capabilityPackStatus(pack),
        details: capabilityPackDetails(pack),
        footer: pack.source,
        category: "Capability packs",
      })),
      ...data.mcps.map((mcp) => ({
        value: { kind: "mcp" as const, mcp },
        title: mcp.name,
        description: mcpServerStatus(mcp),
        details: [mcpEffectiveNote(mcp, data.mcps), ...mcpServerDetails(mcp)].filter(
          (detail): detail is string => !!detail,
        ),
        footer: mcp.type,
        category: "MCP servers",
      })),
      {
        value: { kind: "add-mcp" as const },
        title: "Add MCP server",
        description: "Configure a local command or remote URL",
        category: "Actions",
      },
    ]
  })

  return (
    <Show
      when={!loading()}
      fallback={
        <box paddingLeft={4} paddingRight={4} paddingBottom={2}>
          <text>Loading capability inventory…</text>
        </box>
      }
    >
      <DialogSelect
        title="Capabilities & MCPs"
        options={options()}
        emptyView={<text>No capability packs or MCPs</text>}
        onSelect={(option) => {
          const value = option.value
          if (value.kind === "retry") void refresh()
          if (value.kind === "pack") {
            dialog.replace(() => (
              <DialogCapabilityPack
                client={props.client}
                auth={props.auth}
                sessionID={props.sessionID}
                pack={value.pack}
              />
            ))
          }
          if (value.kind === "mcp") {
            dialog.replace(() => (
              <DialogMcpManager
                client={props.client}
                auth={props.auth}
                inventory={inventory()!}
                mcp={value.mcp}
                sessionID={props.sessionID}
              />
            ))
          }
          if (value.kind === "add-mcp") {
            dialog.replace(() => (
              <DialogMcpManager
                client={props.client}
                auth={props.auth}
                inventory={inventory()!}
                sessionID={props.sessionID}
              />
            ))
          }
        }}
      />
    </Show>
  )
}

function DialogCapabilityPack(props: {
  client: CapabilityManagerClient
  auth?: McpAuthClient
  sessionID?: string
  pack: CapabilityPackSummary
}) {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const initial =
    props.pack.selectedProfiles.length > 0
      ? props.pack.selectedProfiles
      : props.pack.profiles.some((profile) => profile.id === "default")
        ? ["default"]
        : props.pack.profiles.slice(0, 1).map((profile) => profile.id)
  const [profiles, setProfiles] = createSignal(initial)
  const [busy, setBusy] = createSignal(false)

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    if (props.pack.profiles.length === 0) {
      return [
        {
          value: "__unavailable__",
          title: "No manifest profiles available",
          description: props.pack.active
            ? "Deactivate to clear this stale session activation"
            : "Resolve the pack remediation before activation",
          category: "Profiles",
        },
      ]
    }
    return props.pack.profiles.map((profile) => ({
      value: profile.id,
      title: profile.id,
      description: profile.description,
      details: profile.platforms.length ? [`Platforms: ${profile.platforms.join(", ")}`] : [],
      category: "Profiles",
      gutter: () => (
        <text fg={profiles().includes(profile.id) ? theme.success : theme.textMuted}>
          {profiles().includes(profile.id) ? "●" : "○"}
        </text>
      ),
    }))
  })

  async function toggle() {
    if (busy()) return
    setBusy(true)
    const result = await changeCapabilityActivation({
      client: props.client,
      sessionID: props.sessionID,
      id: props.pack.id,
      profiles: profiles(),
      active: !props.pack.active,
    })
    setBusy(false)
    if (!result.ok) {
      toast.show({ variant: "error", message: result.message })
      return
    }
    toast.show({
      variant: result.warning ? "warning" : "success",
      message: props.pack.active
        ? `${props.pack.id} deactivated for this session.`
        : result.warning
          ? `${props.pack.id} activated with warnings: ${result.warning}`
          : `${props.pack.id} activates at the next provider-turn boundary.`,
    })
    dialog.replace(() => <DialogCapabilitiesView client={props.client} auth={props.auth} sessionID={props.sessionID} />)
  }

  return (
    <DialogSelect
      title={`${props.pack.id} capability`}
      titleView={
        <text>
          <span style={{ fg: theme.text }}>
            <b>{props.pack.id} capability</b>
          </span>
          <span style={{ fg: theme.textMuted }}>
            {props.pack.description ? ` · ${props.pack.description}` : ""}
            {props.pack.remediation.length ? ` · ${props.pack.remediation.join("; ")}` : ""}
          </span>
        </text>
      }
      options={options()}
      preserveSelection
      locked={busy()}
      footer={
        <text fg={theme.textMuted}>
          {props.sessionID ? `Session ${props.sessionID}` : "Inventory only — select a session to activate"}
        </text>
      }
      actions={[
        {
          command: "dialog.capability.toggle",
          title: busy() ? "working" : props.pack.active ? "deactivate" : "activate",
          disabled: busy() || !canChangeCapabilityActivation(props.pack, profiles()),
          onTrigger: () => void toggle(),
        },
      ]}
      onSelect={(option) => {
        if (props.pack.profiles.length === 0) return
        if (props.pack.active) return
        const selected = profiles()
        if (selected.includes(option.value) && selected.length === 1) {
          toast.show({ variant: "warning", message: "Choose at least one profile." })
          return
        }
        setProfiles(
          selected.includes(option.value)
            ? selected.filter((profile) => profile !== option.value)
            : [...selected, option.value],
        )
      }}
    />
  )
}

export function DialogCapabilities() {
  const sdk = useSDK()
  const route = useRoute()
  const client: CapabilityManagerClient = {
    list: (input) => sdk.client.capability.list(input),
    enable: (input) => sdk.client.capability.enable(input),
    disable: (input) => sdk.client.capability.disable(input),
    saveMcp: (input) => sdk.client.capability.saveMcp(input),
    checkMcp: (input) => sdk.client.capability.checkMcp(input),
    attachMcp: (input) => sdk.client.capability.attachMcp(input),
  }
  const auth: McpAuthClient = {
    authenticate: (input) => sdk.client.mcp.auth.authenticate(input),
  }
  return (
    <DialogCapabilitiesView
      client={client}
      auth={auth}
      sessionID={route.data.type === "session" ? route.data.sessionID : undefined}
    />
  )
}
