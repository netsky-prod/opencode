export * as CapabilityStore from "./store"

import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Effect, Schema } from "effect"
import { CapabilityManifest } from "@opencode-ai/core/capability/manifest"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { CapabilitySchema } from "./schema"
import { ConfigV2Compat } from "../config/v2-compat"
import { Flock } from "@opencode-ai/core/util/flock"

type Scope = typeof CapabilitySchema.Scope.Type
type Document = { file: string; text: string; revision: string; value: Record<string, unknown> }

// This store owns only explicit manager writes; reads never seed or migrate config.
export function make(options: { globalDirectory: string; projectDirectory: string }) {
  const roots = { global: options.globalDirectory, project: options.projectDirectory }
  const documents = async (scope: Scope) => {
    const candidates = [
      ...(scope === "project" ? [".opencode/opencode.jsonc", ".opencode/opencode.json"] : []),
      "opencode.jsonc",
      "opencode.json",
      ...(scope === "global" ? ["config.json"] : []),
    ]
    const existing = await Promise.all(
      candidates.map(async (name) => {
        const file = path.join(roots[scope], name)
        return (await fs.stat(file).catch(() => undefined))?.isFile() ? file : undefined
      }),
    )
    const files = existing.filter((file) => file !== undefined)
    return Promise.all((files.length ? files : [path.join(roots[scope], "opencode.jsonc")]).map(read))
  }
  const document = async (scope: Scope, name?: string) => {
    const docs = await documents(scope)
    return (name ? docs.find((doc) => Object.hasOwn(servers(doc.value), name)) : undefined) ?? docs[0]
  }

  const inventory = async () => {
    const docs = await Promise.all([documents("global"), documents("project")])
    return {
      configRevisions: { global: docs[0][0].revision, project: docs[1][0].revision },
      mcps: docs.flatMap((layered, index) => [
        ...new Map(
          layered
            .toReversed()
            .flatMap((doc) =>
              Object.entries(servers(doc.value)).map(
                ([name, config]) =>
                  [name, publicMcp(name, index === 0 ? "global" : "project", doc.revision, config)] as const,
              ),
            ),
        ).values(),
      ]),
    }
  }

  const resolve = async (name: string, scope?: Scope) => {
    validateName(name)
    const docs = await Promise.all([document("project", name), document("global", name)])
    for (const [index, doc] of docs.entries()) {
      if (scope && scope !== (index === 0 ? "project" : "global")) continue
      const config = servers(doc.value)[name]
      if (config) return { config, scope: index === 0 ? ("project" as const) : ("global" as const), doc }
    }
    throw new CapabilitySchema.Error({ message: "Configured MCP server not found" })
  }

  const save = async (input: typeof CapabilitySchema.Save.Type) => {
    validateName(input.name)
    const doc = await document(input.scope, input.name)
    await assertContained(doc.file, roots[input.scope])
    return locked(doc.file, async () => {
      const current = await read(doc.file)
      conflict(current, input.revision)
      const previous = servers(current.value)[input.name]
      if (
        previous &&
        ((previous.exposure ?? "always-on") === "always-on" || previous.exposure !== input.exposure) &&
        !input.confirmExposureChange
      ) {
        throw new CapabilitySchema.Error({
          message: "Confirm changing this MCP connection; existing sessions may use this server",
        })
      }
      const config = merge(previous, input.config, input.exposure)
      const next = patchServer(current, input.name, config)
      await atomic(current, next)
      return publicMcp(input.name, input.scope, hash(next), config)
    })
  }

  const packFile = (scope: Scope, id: string) =>
    path.join(roots[scope], ...(scope === "project" ? [".opencode"] : []), "capabilities", id, "capability.json")
  const packRevision = async (scope: Scope, id: string) => (await read(packFile(scope, id))).revision

  const attach = async (input: typeof CapabilitySchema.Attach.Type) => {
    validateName(input.name)
    if (
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.packID) ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.profile)
    ) {
      throw new CapabilitySchema.Error({ message: "Invalid capability pack or profile name" })
    }
    const resolved = await resolve(input.name, input.mcpScope)
    if (input.mcpScope && (await resolve(input.name)).scope !== input.mcpScope) {
      throw new CapabilitySchema.Error({
        message: "This global MCP is shadowed by project configuration; rename it or select the project MCP",
      })
    }
    await assertContained(resolved.doc.file, roots[resolved.scope])
    const file = packFile(input.scope, input.packID)
    await assertContained(file, roots[input.scope])
    // Both locks remain held through validation and writes. A pack is staged first: an
    // interrupted migration leaves the still-always-on reference with zero duplicate tools.
    return locked(resolved.doc.file, () =>
      locked(file, async () => {
        const configDoc = await read(resolved.doc.file)
        conflict(configDoc, input.mcpRevision)
        const config = servers(configDoc.value)[input.name]
        if ((config.exposure ?? "always-on") === "always-on" && !input.confirmExposureChange) {
          throw new CapabilitySchema.Error({ message: "Confirm moving the always-on MCP to pack-only exposure" })
        }
        const pack = await read(file)
        conflict(pack, input.revision)
        const existing = pack.text
          ? await Effect.runPromise(CapabilityManifest.decode(pack.value)).catch(() => {
              throw new CapabilitySchema.Error({ message: "The existing capability manifest is invalid" })
            })
          : undefined
        const runtimeID = input.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/-$/, "")
        const oldRuntime = existing?.runtimes.find((runtime) => runtime.id === runtimeID)
        if (oldRuntime && oldRuntime.mcp !== input.name)
          throw new CapabilitySchema.Error({ message: "Capability runtime name conflicts with this MCP reference" })
        const manifest = {
          ...(existing ?? {
            id: input.packID,
            version: 1,
            description: input.description || input.packID,
            platforms: ["darwin", "linux"],
            skills: [],
            runtimes: [],
            profiles: {},
          }),
          runtimes: [
            ...(existing?.runtimes.filter((runtime) => runtime.id !== runtimeID) ?? []),
            { ...oldRuntime, id: runtimeID, type: "mcp", mcp: input.name },
          ],
          profiles: {
            ...existing?.profiles,
            [input.profile]: {
              ...existing?.profiles[CapabilityManifest.ID.make(input.profile)],
              description:
                existing?.profiles[CapabilityManifest.ID.make(input.profile)]?.description ??
                input.description ??
                input.profile,
              skills: existing?.profiles[CapabilityManifest.ID.make(input.profile)]?.skills ?? [],
              runtimes: [
                ...new Set([
                  ...(existing?.profiles[CapabilityManifest.ID.make(input.profile)]?.runtimes ?? []),
                  runtimeID,
                ]),
              ],
            },
          },
        }
        await Effect.runPromise(CapabilityManifest.decode(manifest)).catch(() => {
          throw new CapabilitySchema.Error({ message: "Invalid capability reference" })
        })
        await atomic(pack, JSON.stringify(manifest, null, 2) + "\n")
        const next = patchServer(configDoc, input.name, { ...config, exposure: "pack-only" })
        await atomic(configDoc, next)
        return { id: input.packID, profile: input.profile, reference: input.name, exposure: "pack-only" as const }
      }),
    )
  }
  return { inventory, save, resolve, attach, packRevision }
}

function validateName(name: string) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(name) || ["constructor", "prototype", "__proto__"].includes(name)) {
    throw new CapabilitySchema.Error({ message: "Invalid MCP server name" })
  }
}

function hash(text: string) {
  return text ? createHash("sha256").update(text).digest("hex") : ""
}

async function read(file: string): Promise<Document> {
  const info = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw new CapabilitySchema.Error({ message: "Cannot read manager configuration" })
  })
  if (info?.isSymbolicLink())
    throw new CapabilitySchema.Error({ message: "Refusing to edit a symbolic-link configuration" })
  const text = info ? await fs.readFile(file, "utf8") : ""
  const errors: ParseError[] = []
  const value: unknown = parse(text || "{}", errors, { allowTrailingComma: true })
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value))
    throw new CapabilitySchema.Error({ message: "Invalid JSONC configuration" })
  return { file, text, revision: hash(text), value: value as Record<string, unknown> }
}

function servers(value: Record<string, unknown>): Record<string, ConfigMCPV1.Info> {
  const lowered = ConfigV2Compat.lower(value, "manager").value
  const mcp = lowered && typeof lowered === "object" && "mcp" in lowered ? lowered.mcp : undefined
  if (!mcp || typeof mcp !== "object") return {}
  return Object.fromEntries(
    Object.entries(mcp).flatMap(([name, value]) => {
      const decoded = Schema.decodeUnknownOption(ConfigMCPV1.Info)(value)
      return decoded._tag === "Some" ? [[name, decoded.value]] : []
    }),
  )
}

function merge(
  previous: ConfigMCPV1.Info | undefined,
  patch: typeof CapabilitySchema.Patch.Type,
  exposure: typeof CapabilitySchema.Exposure.Type,
) {
  const base = previous?.type === patch.type ? previous : undefined
  const value = {
    ...base,
    ...patch,
    exposure,
    ...(patch.type === "local"
      ? { environment: { ...(base?.type === "local" ? base.environment : {}), ...patch.environment } }
      : {
          headers: { ...(base?.type === "remote" ? base.headers : {}), ...patch.headers },
          ...(typeof patch.oauth === "object"
            ? {
                oauth: {
                  ...(base?.type === "remote" && typeof base.oauth === "object" ? base.oauth : {}),
                  ...patch.oauth,
                },
              }
            : {}),
        }),
  }
  const result = Schema.decodeUnknownOption(ConfigMCPV1.Info)(value)
  if (result._tag === "None" || (result.value.type === "local" && result.value.command.length === 0))
    throw new CapabilitySchema.Error({ message: "Provide a valid MCP command or remote URL" })
  if (
    result.value.type === "remote" &&
    (!URL.canParse(result.value.url) || !["https:", "http:"].includes(new URL(result.value.url).protocol))
  )
    throw new CapabilitySchema.Error({ message: "MCP URL must use HTTP or HTTPS" })
  return result.value
}

function patchServer(doc: Document, name: string, config: ConfigMCPV1.Info) {
  const mcp = doc.value.mcp
  const nested =
    mcp &&
    typeof mcp === "object" &&
    "servers" in mcp &&
    mcp.servers &&
    typeof mcp.servers === "object" &&
    !("type" in mcp.servers)
  // Legacy entries inside a V2 envelope are supported by the existing compatibility decoder.
  return applyEdits(
    doc.text || "{}",
    modify(
      doc.text || "{}",
      nested ? ["mcp", "servers", name] : ["mcp", name],
      { ...config, enabled: config.enabled ?? true },
      { formattingOptions: { insertSpaces: true, tabSize: 2 } },
    ),
  )
}

function publicMcp(
  name: string,
  scope: Scope,
  revision: string,
  config: ConfigMCPV1.Info,
): typeof CapabilitySchema.Mcp.Type {
  return {
    name,
    scope,
    revision,
    type: config.type,
    exposure: config.exposure ?? "always-on",
    enabled: config.enabled !== false,
    ...(config.type === "local"
      ? { command: config.command.map((part, index) => (index === 0 ? part : "[redacted]")) }
      : { url: safeURL(config.url) }),
    environmentKeys: config.type === "local" ? Object.keys(config.environment ?? {}).sort() : [],
    headerKeys: config.type === "remote" ? Object.keys(config.headers ?? {}).sort() : [],
    status: "unchecked",
  }
}

function safeURL(value: string) {
  if (!URL.canParse(value)) return "[configured]"
  const url = new URL(value)
  return url.origin
}

function conflict(doc: Document, revision: string) {
  if (doc.revision !== revision)
    throw new CapabilitySchema.Error({ message: "Configuration changed; refresh before saving" })
}

async function assertContained(file: string, root: string) {
  const relative = path.relative(root, file)
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new CapabilitySchema.Error({ message: "Invalid manager storage path" })
  const segments = relative.split(path.sep)
  for (let index = 1; index <= segments.length; index++) {
    const info = await fs.lstat(path.join(root, ...segments.slice(0, index))).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw new CapabilitySchema.Error({ message: "Cannot inspect manager storage path" })
    })
    if (info?.isSymbolicLink())
      throw new CapabilitySchema.Error({ message: "Refusing a symbolic-link capability directory" })
  }
}

async function locked<T>(file: string, operation: () => Promise<T>): Promise<T> {
  // Reuse the repository's cross-process lease, including heartbeat and exclusive
  // stale-breaker ownership. Inode-check + unlink is not a compare-and-swap.
  const lease = await Flock.acquire(`capability-manager:${file}`, {
    dir: path.dirname(file),
    timeoutMs: 5000,
  }).catch(() => {
    throw new CapabilitySchema.Error({ message: "Configuration is being edited; retry after refreshing" })
  })
  await using _ = lease
  return await operation()
}

async function atomic(doc: Document, text: string) {
  conflict(await read(doc.file), doc.revision)
  const temporary = doc.file + "." + crypto.randomUUID() + ".tmp"
  const handle = await fs.open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(text, "utf8")
    await handle.sync()
    await handle.close()
    conflict(await read(doc.file), doc.revision)
    await fs.rename(temporary, doc.file)
  } finally {
    await handle.close().catch(() => {})
    await fs.unlink(temporary).catch(() => {})
  }
}
