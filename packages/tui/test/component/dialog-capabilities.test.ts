import { describe, expect, test } from "bun:test"
import {
  capabilityPackDetails,
  capabilityPackStatus,
  canChangeCapabilityActivation,
  changeCapabilityActivation,
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
} from "../../src/component/dialog-capabilities-model"
import { capabilityManagerCommands } from "../../src/component/dialog-capabilities"

describe("capability manager model", () => {
  test("keeps both capability and MCP slash entries on the same direct manager", () => {
    let opened = 0
    const commands = capabilityManagerCommands(() => {
      opened += 1
    })

    expect(commands.map((command) => [command.name, command.slashName])).toEqual([
      ["capability.list", "capabilities"],
      ["mcp.list", "mcps"],
    ])
    commands.forEach((command) => command.run())
    expect(opened).toBe(2)
  })

  test("renders active profiles and remediation without hiding degraded state", () => {
    const pack: Parameters<typeof capabilityPackStatus>[0] = {
      id: "browser",
      description: "Browser automation",
      source: "builtin",
      revision: "builtin:1",
      profiles: [
        { id: "default", description: "Regular browser tools", platforms: ["darwin", "linux"] },
        { id: "headed", description: "Visible browser", platforms: ["darwin"] },
      ],
      active: true,
      selectedProfiles: ["headed"],
      state: "degraded",
      remediation: ["Install Chromium"],
    }

    expect(capabilityPackStatus(pack)).toBe("active · headed · degraded")
    expect(capabilityPackDetails(pack)).toEqual(["Browser automation", "Remediation: Install Chromium"])
  })

  test("describes inactive packs independently of whether a session is selected", () => {
    expect(
      capabilityPackStatus({
        id: "git",
        description: "Git tools",
        source: "global",
        revision: "user:1",
        profiles: [],
        active: false,
        selectedProfiles: [],
        state: "ready",
        remediation: [],
      }),
    ).toBe("inactive · ready")
  })

  test("allows stale active packs with no manifest profiles to be deactivated", () => {
    const pack: Parameters<typeof canChangeCapabilityActivation>[0] = {
      id: "deleted-pack",
      description: "Manifest no longer exists",
      source: "unavailable",
      revision: "",
      profiles: [],
      active: true,
      selectedProfiles: ["default"],
      state: "unavailable",
      remediation: ["Disable this stale activation."],
    }

    expect(canChangeCapabilityActivation(pack, [])).toBe(true)
    expect(canChangeCapabilityActivation({ ...pack, active: false }, [])).toBe(false)
  })

  test("validates names before mutation", () => {
    expect(validateCapabilityName("team-tools")).toBe("team-tools")
    expect(validateCapabilityName(" Team-Tools ")).toBe("team-tools")
    expect(validateCapabilityName("team_tools")).toBeUndefined()
    expect(validateCapabilityName("1-team")).toBeUndefined()
    expect(validateCapabilityName("../secrets")).toBeUndefined()
    expect(validateCapabilityName("two words")).toBeUndefined()

    expect(validateMcpName(" Search_Server-1 ")).toBe("Search_Server-1")
    expect(validateMcpName("1-search")).toBeUndefined()
    expect(validateMcpName("a".repeat(81))).toBeUndefined()
  })

  test("parses a local command as a JSON string array", () => {
    expect(parseLocalCommand('["bunx", "-y", "@modelcontextprotocol/server-filesystem", "/work"]')).toEqual([
      "bunx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/work",
    ])
    expect(parseLocalCommand('["bunx", 42]')).toBeUndefined()
    expect(parseLocalCommand("bunx server")).toBeUndefined()
  })

  test("normalizes unique credential key lists without accepting malformed names", () => {
    expect(parseKeyList(" TOKEN,API_KEY, TOKEN ")).toEqual(["TOKEN", "API_KEY"])
    expect(parseKeyList("Authorization, X-API-Key")).toEqual(["Authorization", "X-API-Key"])
    expect(parseKeyList("valid, bad key")).toBeUndefined()
  })

  test("builds a local save payload and omits unchanged secret values", () => {
    expect(
      createMcpSaveInput({
        name: "filesystem",
        scope: "project",
        revision: "project:7",
        exposure: "pack-only",
        enabled: false,
        type: "local",
        command: ["bunx", "filesystem", "/work"],
        secrets: { TOKEN: "new-token", API_KEY: "" },
      }),
    ).toEqual({
      name: "filesystem",
      scope: "project",
      revision: "project:7",
      exposure: "pack-only",
      config: {
        type: "local",
        command: ["bunx", "filesystem", "/work"],
        enabled: false,
        environment: { TOKEN: "new-token" },
      },
    })
  })

  test("builds a remote save payload without copying masked headers", () => {
    expect(
      createMcpSaveInput({
        name: "search",
        scope: "global",
        revision: "global:2",
        exposure: "always-on",
        confirmExposureChange: true,
        enabled: true,
        type: "remote",
        url: "https://mcp.example.test/events",
        secrets: { Authorization: "", "X-API-Key": "fresh-secret" },
      }),
    ).toEqual({
      name: "search",
      scope: "global",
      revision: "global:2",
      exposure: "always-on",
      confirmExposureChange: true,
      config: {
        type: "remote",
        url: "https://mcp.example.test/events",
        enabled: true,
        headers: { "X-API-Key": "fresh-secret" },
      },
    })
  })

  test("requires confirmation for exposure changes and every edit of an existing always-on connection", () => {
    const server: Parameters<typeof requiresMcpEditConfirmation>[0] = {
      name: "search",
      scope: "global",
      type: "remote",
      exposure: "always-on",
      enabled: true,
      revision: "global:2",
      environmentKeys: [],
      headerKeys: [],
      status: "connected",
    }

    expect(requiresMcpEditConfirmation(server, "always-on")).toBe(true)
    expect(requiresMcpEditConfirmation({ ...server, exposure: "pack-only" }, "always-on")).toBe(true)
    expect(requiresMcpEditConfirmation({ ...server, exposure: "pack-only" }, "pack-only")).toBe(false)
    expect(requiresMcpEditConfirmation(undefined, "always-on")).toBe(false)
  })

  test("redacts submitted credentials from thrown and structured errors", () => {
    expect(managerErrorMessage(new Error("connection rejected bearer-secret"), ["bearer-secret"])).toBe(
      "connection rejected [redacted]",
    )
    expect(managerErrorMessage({ data: { message: "bad token api-secret" } }, ["api-secret"])).toBe(
      "bad token [redacted]",
    )
    expect(managerErrorMessage({}, [])).toBe("Capability operation failed")
  })

  test("shows MCP storage, exposure, health, and masked credential names separately", () => {
    const server: Parameters<typeof mcpServerStatus>[0] = {
      name: "search",
      scope: "global",
      type: "remote",
      exposure: "pack-only",
      enabled: true,
      revision: "global:2",
      url: "https://mcp.example.test/events",
      environmentKeys: [],
      headerKeys: ["Authorization", "X-API-Key"],
      status: "needs_auth",
    }

    expect(mcpServerStatus(server)).toBe("global · pack-only · enabled · needs auth")
    expect(mcpServerDetails(server)).toEqual([
      "Remote: https://mcp.example.test/events",
      "Headers: Authorization=••••, X-API-Key=••••",
    ])
    expect(createMcpCheckInput(server)).toEqual({ name: "search", scope: "global" })
    expect(mcpServerStatus({ ...server, status: "disabled" })).toBe("global · pack-only · enabled · on demand")
  })

  test("requires a selected real session for activation without calling the server", async () => {
    let calls = 0
    const result = await changeCapabilityActivation({
      client: {
        enable: async () => {
          calls += 1
          return {
            data: {
              id: "browser",
              profiles: ["headed"],
              state: "active",
              nextTurn: true,
              tools: [],
              skills: [],
              availableTools: [],
              availableSkills: [],
              permissionFiltered: false,
              dependencies: [],
              remediation: [],
            },
          }
        },
        disable: async () => {
          calls += 1
          return { data: { id: "browser", state: "disabled", nextTurn: true } }
        },
      },
      sessionID: undefined,
      id: "browser",
      profiles: ["headed"],
      active: true,
    })

    expect(result).toEqual({ ok: false, message: "Select a session before activating a capability pack." })
    expect(calls).toBe(0)
  })

  test("sends the selected profiles directly and does not invent success for an empty response", async () => {
    const inputs: unknown[] = []
    const enabled = await changeCapabilityActivation({
      client: {
        enable: async (input) => {
          inputs.push(input)
          return {
            data: {
              id: "browser",
              profiles: ["headed"],
              state: "active",
              nextTurn: true,
              tools: [],
              skills: [],
              availableTools: [],
              availableSkills: [],
              permissionFiltered: false,
              dependencies: [],
              remediation: [],
            },
          }
        },
        disable: async () => ({ data: { id: "browser", state: "disabled", nextTurn: true } }),
      },
      sessionID: "ses_real",
      id: "browser",
      profiles: ["headed"],
      active: true,
    })
    const missing = await changeCapabilityActivation({
      client: {
        enable: async () => ({}),
        disable: async () => ({}),
      },
      sessionID: "ses_real",
      id: "browser",
      profiles: ["headed"],
      active: false,
    })

    expect(inputs).toEqual([{ sessionID: "ses_real", id: "browser", profiles: ["headed"] }])
    expect(enabled).toEqual({ ok: true })
    expect(missing).toEqual({ ok: false, message: "Capability operation returned no result." })
  })

  test("surfaces unsupported and missing-runtime remediation instead of reporting activation success", async () => {
    const result = await changeCapabilityActivation({
      client: {
        enable: async () => ({
          data: {
            id: "browser",
            profiles: ["headed"],
            state: "failed",
            nextTurn: false,
            tools: [],
            skills: [],
            availableTools: [],
            availableSkills: [],
            permissionFiltered: false,
            dependencies: [{ id: "chromium", state: "missing", checkedAt: 0, remediation: "Install Chromium" }],
            remediation: ["Install Chromium, then retry."],
          },
        }),
        disable: async () => ({ data: { id: "browser", state: "disabled", nextTurn: true } }),
      },
      sessionID: "ses_real",
      id: "browser",
      profiles: ["headed"],
      active: true,
    })

    expect(result).toEqual({
      ok: false,
      message: "Capability browser could not activate (failed). Install Chromium, then retry.",
    })
  })

  test("surfaces a rejected profile error verbatim", async () => {
    const result = await changeCapabilityActivation({
      client: {
        enable: async () => ({ error: { message: "Capability profile not found: browser/wrong" } }),
        disable: async () => ({ data: { id: "browser", state: "disabled", nextTurn: true } }),
      },
      sessionID: "ses_real",
      id: "browser",
      profiles: ["wrong"],
      active: true,
    })

    expect(result).toEqual({ ok: false, message: "Capability profile not found: browser/wrong" })
  })

  test("surfaces transport failures instead of rejecting the dialog action", async () => {
    const result = await changeCapabilityActivation({
      client: {
        enable: async () => {
          throw new Error("connection reset")
        },
        disable: async () => ({ data: { id: "browser", state: "disabled", nextTurn: true } }),
      },
      sessionID: "ses_real",
      id: "browser",
      profiles: ["default"],
      active: true,
    })

    expect(result).toEqual({ ok: false, message: "connection reset" })
  })

  test("attaches by reference with pack revision and an explicit exposure migration confirmation", () => {
    expect(
      createMcpAttachInput({
        mcp: {
          name: "search",
          scope: "global",
          type: "remote",
          exposure: "always-on",
          enabled: true,
          revision: "global:2",
          environmentKeys: [],
          headerKeys: [],
          status: "connected",
        },
        packID: "research",
        profile: "default",
        scope: "project",
        packRevision: "user-pack:5",
        confirmed: true,
      }),
    ).toEqual({
      name: "search",
      scope: "project",
      mcpScope: "global",
      packID: "research",
      profile: "default",
      revision: "user-pack:5",
      mcpRevision: "global:2",
      confirmExposureChange: true,
    })
  })

  test("uses an empty revision and description when attaching to a new user pack", () => {
    expect(
      createMcpAttachInput({
        mcp: {
          name: "filesystem",
          scope: "project",
          type: "local",
          exposure: "pack-only",
          enabled: true,
          revision: "project:4",
          environmentKeys: [],
          headerKeys: [],
          status: "connected",
        },
        packID: "team-files",
        profile: "default",
        scope: "global",
        description: "Team filesystem tools",
        packRevision: "",
        confirmed: false,
      }),
    ).toEqual({
      name: "filesystem",
      scope: "global",
      mcpScope: "project",
      packID: "team-files",
      profile: "default",
      description: "Team filesystem tools",
      revision: "",
      mcpRevision: "project:4",
    })
  })

  test("labels effective-name shadowing before check, auth, or attachment", () => {
    const global: Parameters<typeof mcpEffectiveNote>[0] = {
      name: "search",
      scope: "global",
      type: "remote",
      exposure: "always-on",
      enabled: true,
      revision: "global:1",
      environmentKeys: [],
      headerKeys: [],
      status: "connected",
    }
    const project = { ...global, scope: "project" as const, revision: "project:2" }

    expect(mcpEffectiveNote(global, [global, project])).toBe(
      "Project override is effective by name; this global entry's scoped check or attach may reject.",
    )
    expect(mcpEffectiveNote(project, [global, project])).toBe("This project definition is effective by name.")
  })
})
