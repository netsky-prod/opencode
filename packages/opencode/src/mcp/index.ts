import path from "node:path"
import { pathToFileURL } from "node:url"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  ListRootsRequestSchema,
  type CallToolResult,
  type LoggingMessageNotification,
  LoggingMessageNotificationSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Config } from "@/config/config"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { NamedError } from "@opencode-ai/core/util/error"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { withTimeout } from "@/util/timeout"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { McpOAuthPendingProvider, McpOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { Cause, Effect, Exit, Layer, Context, Schema, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { McpCatalog } from "./catalog"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import { McpBrowser } from "./browser"

const DEFAULT_TIMEOUT = 30_000
const CLIENT_OPTIONS = {
  capabilities: {
    // https://github.com/anomalyco/opencode/issues/11948
    // sampling: {},
    // https://github.com/anomalyco/opencode/issues/23066
    // elicitation: {},
    // https://github.com/anomalyco/opencode/issues/2308
    roots: {},
    // https://github.com/anomalyco/opencode/issues/28567
    // tasks: {},
  },
} satisfies ClientOptions

function closePromise(close: () => Promise<unknown>, timeout = DEFAULT_TIMEOUT) {
  return Effect.tryPromise(() => withTimeout(close(), timeout, `MCP close timed out after ${timeout}ms`)).pipe(
    Effect.ignore,
  )
}

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = McpEvent.ToolsChanged

export const BrowserOpenFailed = McpEvent.BrowserOpenFailed

export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

export class ToolCallError extends Schema.TaggedErrorClass<ToolCallError>()("MCP.ToolCallError", {
  name: Schema.String,
  message: Schema.String,
}) {}
export type MCPError = ToolCallError

type MCPClient = Client

declare const RegistrationType: unique symbol

export interface Registration {
  readonly name: string
  readonly [RegistrationType]: typeof RegistrationType
}

function makeRegistration(name: string) {
  return Object.freeze({ name }) as Registration
}

declare const AuthFlowTokenType: unique symbol
type AuthFlowToken = string & { readonly [AuthFlowTokenType]: typeof AuthFlowTokenType }

function makeAuthFlowToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("") as AuthFlowToken
}

function createClient(directory: string) {
  const client = new Client({ name: "opencode", version: InstallationVersion }, CLIENT_OPTIONS)
  client.setRequestHandler(ListRootsRequestSchema, () =>
    Promise.resolve({ roots: [{ uri: pathToFileURL(directory).href }] }),
  )
  return client
}

const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

// Store transports for OAuth servers to allow finishing auth
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
interface PendingOAuthTransport {
  readonly flowToken: AuthFlowToken
  readonly registration: Registration
  readonly transport: TransportWithAuth
  readonly provider?: McpOAuthPendingProvider
}
const pendingOAuthTransports = new Map<AuthFlowToken, PendingOAuthTransport>()

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type ResourceTemplateInfo = Awaited<ReturnType<MCPClient["listResourceTemplates"]>>["resourceTemplates"][number]
type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCPV1.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

function remoteURL(value: string) {
  if (URL.canParse(value)) return new URL(value)
}

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
  instructions?: string
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  flowToken: AuthFlowToken
  client?: MCPClient
}

// --- Effect Service ---

interface State {
  config: Record<string, ConfigMCPV1.Info>
  registrations: Record<string, Registration>
  hidden: Set<string>
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
  instructions: Record<string, string>
}

function ownsRegistration(
  s: State,
  name: string,
  registration: Registration | undefined,
): registration is Registration {
  return registration !== undefined && s.registrations[name] === registration
}

export interface ServerInstructions {
  name: string
  instructions: string
  tools: string[]
}

/** An MCP tool in its native shape; consumers adapt it to their own tool format. */
export interface McpTool {
  /** Shared cached definition; consumers must copy rather than mutate it. */
  readonly def: MCPToolDef
  readonly client: MCPClient
  readonly timeout?: number
}

export interface Definition {
  readonly upstreamName: string
  readonly description: string
  readonly inputSchema: JSONSchema7
  readonly call: (input: unknown, signal?: AbortSignal) => Effect.Effect<CallToolResult, MCPError>
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly instructions: () => Effect.Effect<ServerInstructions[]>
  readonly tools: () => Effect.Effect<Record<string, McpTool>>
  readonly definitions: (name: string) => Effect.Effect<ReadonlyArray<Definition>>
  readonly connection: (registration: string | Registration) => Effect.Effect<Status | undefined>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: (clientName?: string) => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly resourceTemplates: (
    clientName?: string,
  ) => Effect.Effect<Record<string, ResourceTemplateInfo & { client: string }>>
  readonly add: (
    name: string,
    mcp: ConfigMCPV1.Info,
    options?: { readonly hidden?: boolean },
  ) => Effect.Effect<{ status: Record<string, Status> | Status; registration: Registration }>
  readonly remove: (registration: Registration) => Effect.Effect<void, NotFoundError>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string; flowToken: string }, NotFoundError>
  readonly authenticate: (
    mcpName: string,
    onAuthorization?: (authorizationUrl: string) => void,
  ) => Effect.Effect<Status, NotFoundError>
  readonly finishAuth: (
    mcpName: string,
    authorizationCode: string,
    flowToken: string,
  ) => Effect.Effect<Status, NotFoundError>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const events = yield* EventV2Bridge.Service
    const browser = yield* McpBrowser.Service

    const closePending = (pending: PendingOAuthTransport, timeout?: number) =>
      closePromise(() => pending.transport.close(), timeout)

    const takePending = (registration: Registration) => {
      for (const [flowToken, pending] of pendingOAuthTransports) {
        if (pending.registration !== registration) continue
        pendingOAuthTransports.delete(flowToken)
        return pending
      }
    }

    const replacePending = (pending: PendingOAuthTransport, timeout?: number) => {
      const previous = takePending(pending.registration)
      pendingOAuthTransports.set(pending.flowToken, pending)
      return previous ? closePending(previous, timeout) : Effect.void
    }

    type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = Effect.fn("MCP.connectTransport")(function* (transport: Transport, timeout: number) {
      const directory = yield* InstanceState.directory
      return yield* Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
          Effect.tryPromise({
            try: () => {
              const client = createClient(directory)
              return withTimeout(client.connect(t), timeout).then(() => client)
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
        (t, exit) => (Exit.isFailure(exit) ? closePromise(() => t.close(), timeout) : Effect.void),
      )
    })

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      key: string,
      mcp: ConfigMCPV1.Info & { type: "remote" },
      registration: Registration,
    ) {
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      const url = remoteURL(mcp.url)
      if (!url) {
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: `Invalid MCP URL for "${key}"` },
        }
      }
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            callbackPort: oauthConfig?.callbackPort,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            onRedirect: async () => {},
          },
          auth,
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      let lastStatus: Status | undefined

      for (const { name, transport } of transports) {
        const result = yield* connectTransport(transport, connectTimeout).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new Error(String(error))
            const isAuthError =
              error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                lastStatus = {
                  status: "needs_client_registration" as const,
                  error: "Server does not support dynamic client registration. Please provide clientId in config.",
                }
                return events
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              } else {
                lastStatus = { status: "needs_auth" as const }
                return replacePending({ flowToken: makeAuthFlowToken(), registration, transport }, mcp.timeout).pipe(
                  Effect.andThen(
                    events.publish(TuiEvent.ToastShow, {
                      title: "MCP Authentication Required",
                      message: `Server "${key}" requires authentication. Run: opencode mcp auth ${key}`,
                      variant: "warning",
                      duration: 8000,
                    }),
                  ),
                  Effect.ignore,
                  Effect.as(undefined),
                )
              }
            }

            lastStatus = { status: "failed" as const, error: lastError.message }
            return Effect.void
          }),
        )
        if (result) return { client: result.client, status: { status: "connected" } as Status }
        // If this was an auth error, stop trying other transports
        if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
      }
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      key: string,
      mcp: ConfigMCPV1.Info & { type: "local" },
    ) {
      const [cmd, ...args] = mcp.command
      const baseDir = yield* InstanceState.directory
      const cwd = mcp.cwd ? path.resolve(baseDir, mcp.cwd) : baseDir
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: {
          ...process.env,
          ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
          ...mcp.environment,
        },
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status } => ({
          client,
          status: { status: "connected" },
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status }> => {
          const msg = error instanceof Error ? error.message : String(error)
          return Effect.succeed({ client: undefined, status: { status: "failed", error: msg } })
        }),
      )
    })

    const create = Effect.fn("MCP.create")(
      function* (key: string, mcp: ConfigMCPV1.Info, registration: Registration) {
        if (mcp.enabled === false) {
          return DISABLED_RESULT
        }

        const { client: mcpClient, status } =
          mcp.type === "remote"
            ? yield* connectRemote(key, mcp as ConfigMCPV1.Info & { type: "remote" }, registration)
            : yield* connectLocal(key, mcp as ConfigMCPV1.Info & { type: "local" })

        if (!mcpClient) {
          if (status.status !== "connected" && status.status !== "disabled") {
            yield* Effect.logWarning("server unavailable", { key, type: mcp.type, status: status.status })
          }
          return { status } satisfies CreateResult
        }

        return yield* Effect.gen(function* () {
          const listed = mcpClient.getServerCapabilities()?.tools ? yield* McpCatalog.defs(mcpClient, mcp.timeout) : []
          if (!listed) {
            return yield* Effect.fail(new Error("Failed to get tools"))
          }
          return {
            mcpClient,
            status,
            defs: listed,
            instructions: mcpClient.getInstructions()?.trim(),
          } satisfies CreateResult
        }).pipe(
          Effect.catchCause((cause) =>
            closePromise(() => mcpClient.close(), mcp.timeout).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        )
      },
      Effect.map((result): CreateResult => result),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        const error = Cause.squash(cause)
        return Effect.succeed<CreateResult>({
          status: { status: "failed", error: error instanceof Error ? error.message : String(error) },
        })
      }),
    )
    const cfgSvc = yield* Config.Service

    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        for (let index = 0; index < queue.length; index++) {
          const current = queue[index]
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )

    function watch(s: State, name: string, client: MCPClient, bridge: EffectBridge.Shape, timeout?: number) {
      client.onclose = () => {
        if (s.clients[name] !== client) return
        delete s.clients[name]
        delete s.defs[name]
        delete s.instructions[name]
        s.status[name] = { status: "failed", error: "Connection closed" }
        bridge.fork(
          Effect.logWarning("MCP connection closed", { server: name }).pipe(
            Effect.andThen(events.publish(ToolsChanged, { server: name })),
            Effect.ignore,
          ),
        )
      }

      client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) =>
        bridge.promise(serverLog(name, notification.params)),
      )

      if (!client.getServerCapabilities()?.tools) return
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const listed = await bridge.promise(McpCatalog.defs(client, timeout))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        await bridge.promise(events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
    }

    function serverLog(name: string, params: LoggingMessageNotification["params"]) {
      const fields = { server: name, logger: params.logger, level: params.level, data: params.data }
      switch (params.level) {
        case "debug":
          return Effect.logDebug("MCP server log", fields)
        case "info":
        case "notice":
          return Effect.logInfo("MCP server log", fields)
        case "warning":
          return Effect.logWarning("MCP server log", fields)
        case "error":
        case "critical":
        case "alert":
        case "emergency":
          return Effect.logError("MCP server log", fields)
      }
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        const bridge = yield* EffectBridge.make()
        const config = cfg.mcp ?? {}
        const s: State = {
          config: {},
          registrations: {},
          hidden: new Set(),
          status: {},
          clients: {},
          defs: {},
          instructions: {},
        }

        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (!isMcpConfigured(mcp)) {
                yield* Effect.logError("Ignoring MCP config entry without type", { key })
                return
              }

              const registration = makeRegistration(key)
              s.registrations[key] = registration
              if (mcp.enabled === false) {
                s.status[key] = { status: "disabled" }
                return
              }

              const result = yield* create(key, mcp, registration)
              s.status[key] = result.status
              if (result.mcpClient) {
                s.clients[key] = result.mcpClient
                s.defs[key] = result.defs!
                if (result.instructions) s.instructions[key] = result.instructions
                watch(s, key, result.mcpClient, bridge, mcp.timeout)
              }
            }),
          { concurrency: "unbounded" },
        )

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const clients = Object.entries(s.clients)
            const pending = Object.values(s.registrations).flatMap((registration) => {
              const item = takePending(registration)
              return item ? [item] : []
            })
            s.clients = {}
            s.defs = {}
            s.instructions = {}
            yield* Effect.all(
              [
                Effect.forEach(
                  clients,
                  ([name, client]) =>
                    Effect.gen(function* () {
                      const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
                      if (typeof pid === "number") {
                        const pids = yield* descendants(pid)
                        for (const dpid of pids) {
                          try {
                            process.kill(dpid, "SIGTERM")
                          } catch {}
                        }
                      }
                      const configured = s.config[name] ?? config[name]
                      const timeout = isMcpConfigured(configured) ? configured.timeout : undefined
                      yield* closePromise(() => client.close(), timeout)
                    }),
                  { concurrency: "unbounded", discard: true },
                ),
                Effect.forEach(pending, (item) => closePending(item), {
                  concurrency: "unbounded",
                  discard: true,
                }),
              ],
              { concurrency: "unbounded", discard: true },
            )
          }),
        )

        return s
      }),
    )

    function closeClient(s: State, name: string, timeout?: number) {
      const client = s.clients[name]
      delete s.clients[name]
      delete s.defs[name]
      delete s.instructions[name]
      if (!client) return Effect.void
      return closePromise(() => client.close(), timeout)
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      instructions: string | undefined,
      timeout?: number,
      registration?: Registration,
    ) {
      const bridge = yield* EffectBridge.make()
      if (!ownsRegistration(s, name, registration)) {
        yield* closePromise(() => client.close(), timeout)
        return { status: "connected" } satisfies Status
      }
      const previous = s.clients[name]
      const connected = { status: "connected" } satisfies Status
      s.status[name] = connected
      s.clients[name] = client
      s.defs[name] = listed
      if (instructions) s.instructions[name] = instructions
      else delete s.instructions[name]
      watch(s, name, client, bridge, timeout)
      if (previous) yield* closePromise(() => previous.close(), timeout)
      return connected
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      for (const key of Object.keys(s.config)) {
        if (s.hidden.has(key)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const connection = Effect.fn("MCP.connection")(function* (registration: string | Registration) {
      const s = yield* InstanceState.get(state)
      if (typeof registration === "string") return s.status[registration]
      if (s.registrations[registration.name] !== registration) return undefined
      return s.status[registration.name]
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.fromEntries(Object.entries(s.clients).filter(([name]) => !s.hidden.has(name)))
    })

    const instructions = Effect.fn("MCP.instructions")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.entries(s.instructions)
        .filter(([name]) => s.status[name]?.status === "connected" && !s.hidden.has(name))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => ({
          name,
          instructions: item,
          tools: (s.defs[name] ?? []).map((tool) => McpCatalog.toolName(name, tool.name)),
        }))
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (
      name: string,
      mcp: ConfigMCPV1.Info,
      registration: Registration | undefined,
    ) {
      const s = yield* InstanceState.get(state)
      if (!ownsRegistration(s, name, registration)) return s.status[name] ?? ({ status: "disabled" } satisfies Status)
      const result = yield* create(name, mcp, registration)

      if (!ownsRegistration(s, name, registration)) {
        const pending = takePending(registration)
        yield* Effect.all(
          [
            result.mcpClient ? closePromise(() => result.mcpClient!.close(), mcp.timeout) : Effect.void,
            pending ? closePending(pending, mcp.timeout) : Effect.void,
          ],
          { concurrency: "unbounded", discard: true },
        )
        return result.status
      }

      s.status[name] = result.status
      if (!result.mcpClient) {
        yield* closeClient(s, name, mcp.timeout)
        return result.status
      }

      return yield* storeClient(s, name, result.mcpClient, result.defs!, result.instructions, mcp.timeout, registration)
    })

    const removeOwned = Effect.fnUntraced(function* (s: State, registration: Registration) {
      const name = registration.name
      if (s.registrations[name] !== registration) return false
      const timeout = s.config[name]?.timeout
      const pending = takePending(registration)
      delete s.registrations[name]
      delete s.config[name]
      s.hidden.delete(name)
      delete s.status[name]
      yield* Effect.all([closeClient(s, name, timeout), pending ? closePending(pending, timeout) : Effect.void], {
        concurrency: "unbounded",
        discard: true,
      })
      if (s.registrations[name]) return true
      delete s.status[name]
      delete s.defs[name]
      delete s.instructions[name]
      return true
    })

    const add = Effect.fn("MCP.add")(function* (
      name: string,
      mcp: ConfigMCPV1.Info,
      options?: { readonly hidden?: boolean },
    ) {
      const s = yield* InstanceState.get(state)
      const previousRegistration = s.registrations[name]
      const previousPending = previousRegistration ? takePending(previousRegistration) : undefined
      const previousTimeout = s.config[name]?.timeout
      const registration = makeRegistration(name)
      s.config[name] = mcp
      s.registrations[name] = registration
      if (options?.hidden) s.hidden.add(name)
      else s.hidden.delete(name)
      return yield* (previousPending ? closePending(previousPending, previousTimeout) : Effect.void).pipe(
        Effect.andThen(createAndStore(name, mcp, registration)),
        Effect.as({ status: s.status, registration }),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? removeOwned(s, registration).pipe(Effect.asVoid) : Effect.void,
        ),
      )
    })

    const remove = Effect.fn("MCP.remove")(function* (registration: Registration) {
      const s = yield* InstanceState.get(state)
      if (!(yield* removeOwned(s, registration))) return yield* new NotFoundError({ name: registration.name })
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const registration = s.registrations[name]
      const mcp = yield* requireMcpConfig(name)
      if (!ownsRegistration(s, name, registration)) return
      yield* createAndStore(name, { ...mcp, enabled: true }, registration)
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const registration = s.registrations[name]
      const mcp = yield* requireMcpConfig(name)
      if (!ownsRegistration(s, name, registration)) return
      const pending = takePending(registration)
      yield* Effect.all(
        [closeClient(s, name, mcp.timeout), pending ? closePending(pending, mcp.timeout) : Effect.void],
        { concurrency: "unbounded", discard: true },
      )
      if (!ownsRegistration(s, name, registration)) return
      s.status[name] = { status: "disabled" }
    })

    function requestTimeout(s: State, name: string, configured: McpEntry | undefined, fallback?: number) {
      const staticTimeout = configured && isMcpConfigured(configured) ? configured.timeout : undefined
      return s.config[name]?.timeout ?? staticTimeout ?? fallback
    }

    const tools = Effect.fn("MCP.tools")(function* () {
      const result: Record<string, McpTool> = {}
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const defaultTimeout = cfg.experimental?.mcp_timeout

      for (const [clientName, client] of Object.entries(s.clients)) {
        if (s.status[clientName]?.status !== "connected" || s.hidden.has(clientName)) continue
        const mcpConfig = config[clientName]
        const listed = s.defs[clientName]
        if (!listed) {
          yield* Effect.logWarning("missing cached tools for connected server", { clientName })
          continue
        }
        const timeout = requestTimeout(s, clientName, mcpConfig, defaultTimeout)
        for (const def of listed) {
          result[McpCatalog.toolName(clientName, def.name)] = { def, client, timeout }
        }
      }
      return result
    })

    const definitions = Effect.fn("MCP.definitions")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[name]
      const listed = s.defs[name]
      if (!client || !listed || s.status[name]?.status !== "connected") return []
      const cfg = yield* cfgSvc.get()
      const timeout = requestTimeout(s, name, cfg.mcp?.[name], cfg.experimental?.mcp_timeout)
      return Object.freeze(
        listed.map((def) => {
          const inputSchema = freeze(structuredClone(def.inputSchema)) as JSONSchema7
          return Object.freeze({
            upstreamName: def.name,
            description: def.description ?? "",
            inputSchema,
            call: (input: unknown, signal?: AbortSignal) =>
              Effect.tryPromise({
                try: () =>
                  client.callTool({ name: def.name, arguments: record(input) }, CallToolResultSchema, {
                    resetTimeoutOnProgress: true,
                    signal,
                    timeout,
                    onprogress: () => {},
                  }),
                catch: (error) =>
                  new ToolCallError({
                    name: def.name,
                    message: error instanceof Error ? error.message : String(error),
                  }),
              }).pipe(
                Effect.flatMap((result) =>
                  result.isError
                    ? Effect.fail(
                        new ToolCallError({
                          name: def.name,
                          message:
                            result.content
                              .flatMap((item) => (item.type === "text" ? [item.text] : []))
                              .filter((text) => text.trim())
                              .join("\n\n") || "MCP tool returned an error",
                        }),
                      )
                    : Effect.succeed(result),
                ),
              ),
          }) satisfies Definition
        }),
      )
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client, timeout?: number) => Promise<T[]>,
      label: string,
      key?: (item: T) => string,
      targetClientName?: string,
    ) {
      return Effect.gen(function* () {
        const cfg = yield* cfgSvc.get()
        return yield* Effect.forEach(
          Object.entries(s.clients).filter(
            ([name]) =>
              s.status[name]?.status === "connected" &&
              !s.hidden.has(name) &&
              (!targetClientName || name === targetClientName),
          ),
          ([clientName, client]) =>
            McpCatalog.fetch(
              clientName,
              client,
              (c) => listFn(c, requestTimeout(s, clientName, cfg.mcp?.[clientName], cfg.experimental?.mcp_timeout)),
              label,
              key,
            ).pipe(Effect.map((items) => Object.entries(items ?? {}))),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
      })
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      return yield* collectFromConnected(yield* InstanceState.get(state), McpCatalog.prompts, "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* InstanceState.get(state),
        McpCatalog.resources,
        "resources",
        (resource) => resource.uri,
        clientName,
      )
    })

    const resourceTemplates = Effect.fn("MCP.resourceTemplates")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* InstanceState.get(state),
        McpCatalog.resourceTemplates,
        "resource templates",
        (template) => template.uriTemplate,
        clientName,
      )
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient, timeout?: number) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        yield* Effect.logWarning(`client not found for ${label}`, { clientName })
        return undefined
      }
      const cfg = yield* cfgSvc.get()
      return yield* Effect.tryPromise({
        try: () => fn(client, requestTimeout(s, clientName, cfg.mcp?.[clientName], cfg.experimental?.mcp_timeout)),
        catch: (error) => error,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError(`failed to ${label}`, {
            clientName,
            ...meta,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
        Effect.orElseSucceed(() => undefined),
      )
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.getPrompt({ name, arguments: args }, { timeout }),
        "getPrompt",
        { promptName: name },
      )
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.readResource({ uri: resourceUri }, { timeout }),
        "readResource",
        { resourceUri },
      )
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const s = yield* InstanceState.get(state)
      if (s.config[mcpName]) return s.config[mcpName]

      const cfg = yield* cfgSvc.get()
      const mcpConfig = cfg.mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    const requireMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return yield* new NotFoundError({ name: mcpName })
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const s = yield* InstanceState.get(state)
      const registration = s.registrations[mcpName]
      if (!ownsRegistration(s, mcpName, registration)) return yield* new NotFoundError({ name: mcpName })
      const mcpConfig = yield* requireMcpConfig(mcpName)
      if (!ownsRegistration(s, mcpName, registration)) return yield* new NotFoundError({ name: mcpName })
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
      const url = remoteURL(mcpConfig.url)
      if (!url) throw new Error(`Invalid MCP URL for "${mcpName}"`)

      // OAuth config is optional - if not provided, we'll use auto-discovery
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // Resolve effective redirect URI: explicit redirectUri > callbackPort shorthand > default
      const effectiveRedirectUri =
        oauthConfig?.redirectUri ??
        (oauthConfig?.callbackPort ? `http://127.0.0.1:${oauthConfig.callbackPort}${OAUTH_CALLBACK_PATH}` : undefined)

      // Start the callback server with custom redirectUri if configured
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(effectiveRedirectUri))

      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      const flowToken = makeAuthFlowToken()
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthPendingProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.clientId,
          clientSecret: oauthConfig?.clientSecret,
          scope: oauthConfig?.scope,
          redirectUri: effectiveRedirectUri,
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
      )

      const transport = new StreamableHTTPClientTransport(url, {
        authProvider,
        requestInit: mcpConfig.headers ? { headers: mcpConfig.headers } : undefined,
      })
      const directory = yield* InstanceState.directory

      return yield* Effect.tryPromise({
        try: () => {
          const client = createClient(directory)
          return client.connect(transport).then(async () => {
            await authProvider.commit()
            return { authorizationUrl: "", oauthState, flowToken, client } satisfies AuthResult
          })
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof UnauthorizedError && capturedUrl) {
            if (!ownsRegistration(s, mcpName, registration)) {
              return closePromise(() => transport.close(), mcpConfig.timeout).pipe(
                Effect.andThen(Effect.fail(new NotFoundError({ name: mcpName }))),
              )
            }
            return replacePending(
              { flowToken, registration, transport, provider: authProvider },
              mcpConfig.timeout,
            ).pipe(Effect.as({ authorizationUrl: capturedUrl.toString(), oauthState, flowToken } satisfies AuthResult))
          }
          return Effect.die(error)
        }),
        Effect.map((result): AuthResult => result),
      )
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (
      mcpName: string,
      onAuthorization?: (authorizationUrl: string) => void,
    ) {
      const s = yield* InstanceState.get(state)
      const registration = s.registrations[mcpName]
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const client = "client" in result ? result.client : undefined
        const mcpConfig = yield* requireMcpConfig(mcpName).pipe(
          Effect.tapError(() => closePromise(() => client?.close() ?? Promise.resolve())),
        )

        const listed = client
          ? client.getServerCapabilities()?.tools
            ? yield* McpCatalog.defs(client, mcpConfig.timeout)
            : []
          : undefined
        if (!client || !listed) {
          yield* closePromise(() => client?.close() ?? Promise.resolve(), mcpConfig.timeout)
          return { status: "failed", error: "Failed to get tools" } satisfies Status
        }

        if (!ownsRegistration(s, mcpName, registration)) {
          yield* closePromise(() => client.close(), mcpConfig.timeout)
          return s.status[mcpName] ?? ({ status: "disabled" } satisfies Status)
        }
        yield* auth.clearOAuthState(mcpName)
        return yield* storeClient(
          s,
          mcpName,
          client,
          listed,
          client.getInstructions()?.trim(),
          mcpConfig.timeout,
          registration,
        )
      }

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)
      onAuthorization?.(result.authorizationUrl)

      yield* browser.open(result.authorizationUrl).pipe(
        Effect.catch(() => {
          return events.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      if (!ownsRegistration(s, mcpName, registration)) {
        return s.status[mcpName] ?? ({ status: "disabled" } satisfies Status)
      }
      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuthOwned(mcpName, code, result.flowToken)
    })

    const finishAuthOwned = Effect.fnUntraced(function* (
      mcpName: string,
      authorizationCode: string,
      flowToken: string,
    ) {
      const s = yield* InstanceState.get(state)
      const pending = pendingOAuthTransports.get(flowToken as AuthFlowToken)
      if (!pending || pending.flowToken !== flowToken || pending.registration.name !== mcpName) {
        if (!s.registrations[mcpName]) return yield* new NotFoundError({ name: mcpName })
        throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)
      }
      const registration = pending.registration
      if (!ownsRegistration(s, mcpName, registration)) throw new Error(`Stale OAuth flow for MCP server: ${mcpName}`)
      const initialConfig = yield* requireMcpConfig(mcpName)
      if (!ownsRegistration(s, mcpName, registration)) throw new Error(`Stale OAuth flow for MCP server: ${mcpName}`)

      const error = yield* Effect.tryPromise({
        try: () => pending.transport.finishAuth(authorizationCode),
        catch: (error) => error,
      }).pipe(
        Effect.match({
          onFailure: (error) => (error instanceof Error ? error.message : String(error)),
          onSuccess: () => undefined,
        }),
      )

      if (error) return { status: "failed", error: `OAuth completion failed: ${error}` } satisfies Status

      if (!ownsRegistration(s, mcpName, registration)) {
        return s.status[mcpName] ?? ({ status: "disabled" } satisfies Status)
      }
      yield* Effect.promise(() => pending.provider?.commit() ?? Promise.resolve())
      if (!ownsRegistration(s, mcpName, registration)) {
        return s.status[mcpName] ?? ({ status: "disabled" } satisfies Status)
      }
      yield* auth.clearCodeVerifier(mcpName)
      if (!ownsRegistration(s, mcpName, registration)) {
        return s.status[mcpName] ?? ({ status: "disabled" } satisfies Status)
      }
      if (pendingOAuthTransports.get(pending.flowToken) === pending) {
        pendingOAuthTransports.delete(pending.flowToken)
        yield* closePending(pending, initialConfig.timeout)
      }
      if (!ownsRegistration(s, mcpName, registration)) {
        return s.status[mcpName] ?? ({ status: "disabled" } satisfies Status)
      }

      const mcpConfig = yield* requireMcpConfig(mcpName)

      return yield* createAndStore(mcpName, { ...mcpConfig, enabled: true }, registration)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (
      mcpName: string,
      authorizationCode: string,
      flowToken: string,
    ) {
      return yield* finishAuthOwned(mcpName, authorizationCode, flowToken)
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      const s = yield* InstanceState.get(state)
      const registration = s.registrations[mcpName]
      const pending = registration ? takePending(registration) : undefined
      McpOAuthCallback.cancelPending(mcpName)
      yield* Effect.all(
        [auth.remove(mcpName), pending ? closePending(pending, s.config[mcpName]?.timeout) : Effect.void],
        { concurrency: "unbounded", discard: true },
      )
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const runtimeConfig = (yield* InstanceState.has(state))
        ? (yield* InstanceState.get(state)).config[mcpName]
        : undefined
      const mcpConfig = runtimeConfig ?? (yield* cfgSvc.get()).mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig) || mcpConfig.type !== "remote") return "not_authenticated"
      const entry = yield* auth.getForUrl(mcpName, mcpConfig.url)
      if (!entry?.tokens) return "not_authenticated"
      if (entry.tokens.expiresAt && entry.tokens.expiresAt < Date.now() / 1000) return "expired"
      return "authenticated"
    })

    return Service.of({
      status,
      clients,
      instructions,
      tools,
      definitions,
      connection,
      prompts,
      resources,
      resourceTemplates,
      add,
      remove,
      connect,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [CrossSpawnSpawner.node, McpAuth.node, EventV2Bridge.node, Config.node, McpBrowser.node],
})

export * as MCP from "."
