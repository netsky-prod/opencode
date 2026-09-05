/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

test("capability inventory renders without a session and never reveals credentials", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const calls: unknown[] = []
  let releaseList!: () => void
  const listReady = new Promise<void>((resolve) => (releaseList = resolve))
  const { DialogCapabilitiesView } = await import("../../../src/component/dialog-capabilities")
  const [
    { DialogProvider, useDialog },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    keymapModule,
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  const client = {
    list: async (input: { sessionID?: string }) => {
      calls.push(input)
      await listReady
      return {
        data: {
          packs: [
            {
              id: "browser",
              description: "Browser automation",
              source: "builtin" as const,
              revision: "builtin:1",
              profiles: [{ id: "headed", description: "Visible browser", platforms: ["darwin"] }],
              active: false,
              selectedProfiles: [],
              state: "degraded",
              remediation: ["Install Chromium"],
            },
          ],
          mcps: [
            {
              name: "search",
              scope: "global" as const,
              type: "remote" as const,
              exposure: "pack-only" as const,
              enabled: true,
              revision: "global:2",
              url: "https://mcp.example.test/[redacted]",
              environmentKeys: [],
              headerKeys: ["Authorization"],
              status: "shadowed",
            },
            {
              name: "search",
              scope: "project" as const,
              type: "remote" as const,
              exposure: "pack-only" as const,
              enabled: true,
              revision: "project:4",
              url: "https://project.example.test/[redacted]",
              environmentKeys: [],
              headerKeys: [],
              status: "connected",
            },
          ],
          configRevisions: { global: "global:2", project: "project:4" },
        },
      }
    },
    enable: async () => ({
      data: {
        id: "browser",
        profiles: ["headed"],
        state: "active" as const,
        nextTurn: true,
        tools: [],
        skills: [],
        availableTools: [],
        availableSkills: [],
        permissionFiltered: false,
        dependencies: [],
        remediation: [],
      },
    }),
    disable: async () => ({ data: { id: "browser", state: "disabled" as const, nextTurn: true } }),
    saveMcp: async () => ({ data: {} }),
    checkMcp: async () => ({ data: { name: "search", state: "connected" as const, tools: [], remediation: [] } }),
    attachMcp: async () => ({ data: {} }),
  }

  function Launcher() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogCapabilitiesView client={client} />))
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = keymapModule.registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <keymapModule.OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <Launcher />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </keymapModule.OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30, kittyKeyboard: true })
  try {
    await app.renderOnce()
    for (let attempt = 0; calls.length === 0 && attempt < 20; attempt++) await Bun.sleep(10)
    app.mockInput.pressKey("q")
    app.mockInput.pressKey("q")
    app.mockInput.pressKey("q")
    await app.renderOnce()
    const loadingFrame = app.captureCharFrame()
    expect(loadingFrame).toContain("Loading capability inventory")
    expect(loadingFrame).not.toContain("Capabilities & MCPs")
    expect(loadingFrame).not.toContain("qqq")
    releaseList()
    for (let attempt = 0; !app.captureCharFrame().includes("Capabilities & MCPs") && attempt < 20; attempt++) {
      await Bun.sleep(10)
      await app.renderOnce()
    }
    await app.renderOnce()
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(calls).toEqual([{}])
    expect(frame).toContain("Capabilities & MCPs")
    expect(frame).toContain("inactive · degraded")
    expect(frame).toContain("Remediation: Install Chromium")
    expect(frame).toContain("global · pack-only · enabled")
    expect(frame).toContain("Project override is effective by name")
    expect(frame).not.toContain("bearer-secret")
  } finally {
    app.renderer.destroy()
  }
})
