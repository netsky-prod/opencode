export * as CapabilityCatalog from "./catalog"

import fs from "fs/promises"
import os from "os"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { AbsolutePath } from "../schema"
import { CapabilityManifest } from "./manifest"

export type Source = "builtin" | "global" | "project"

export type Skill = CapabilityManifest.Skill & {
  readonly location: AbsolutePath
  readonly content?: string
}

export type Pack = Omit<CapabilityManifest.Manifest, "skills"> & {
  readonly source: Source
  readonly directory: AbsolutePath
  readonly skills: ReadonlyArray<Skill>
}

export type Embedded = {
  readonly manifest: CapabilityManifest.Manifest
  readonly directory: string
  readonly skills?: Readonly<Record<string, string>>
}

export type Options = {
  readonly builtins?: ReadonlyArray<Embedded>
  readonly globalDirectory?: string
  readonly projectDirectory: string
}

export interface Interface {
  readonly list: () => Effect.Effect<ReadonlyArray<Pack>>
  readonly get: (id: string) => Effect.Effect<Pack | undefined>
  readonly search: (query: string, active: ReadonlySet<string>) => Effect.Effect<ReadonlyArray<Pack>>
  readonly register: (pack: Embedded) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CapabilityCatalog") {}

export const make = (options: Options): Effect.Effect<Interface> =>
  Effect.sync(() => {
    const builtins = [...(options.builtins ?? [])]
    const globalDirectory =
      options.globalDirectory ??
      path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode", "capabilities")
    const projectDirectory = path.join(options.projectDirectory, ".opencode", "capabilities")

    const discover = async () => {
      const sources = await Promise.all([
        loadEmbedded(builtins),
        loadDirectory(globalDirectory, "global"),
        loadDirectory(projectDirectory, "project"),
      ])
      const packs = new Map<string, Pack>()
      for (const source of sources) for (const pack of source) packs.set(pack.id, pack)
      return freeze([...packs.values()].toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    return Service.of({
      list: () => Effect.promise(discover),
      get: (id) => Effect.promise(discover).pipe(Effect.map((packs) => packs.find((pack) => pack.id === id))),
      search: (query, active) =>
        Effect.promise(discover).pipe(
          Effect.map((packs) =>
            freeze(
              packs
                .map((pack) => ({ pack, score: score(pack, query), active: active.has(pack.id) }))
                .filter((item) => item.score > 0)
                .toSorted(
                  (a, b) =>
                    b.score - a.score || Number(a.active) - Number(b.active) || a.pack.id.localeCompare(b.pack.id),
                )
                .map((item) => item.pack),
            ),
          ),
        ),
      register: (pack) =>
        Effect.sync(() => {
          builtins.push(pack)
        }),
    })
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    return yield* make({ projectDirectory: location.project.directory })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node] })

async function loadEmbedded(entries: ReadonlyArray<Embedded>) {
  return Promise.all(entries.map((entry) => loadPack(entry.manifest, entry.directory, "builtin", entry.skills)))
}

async function loadDirectory(directory: string, source: Exclude<Source, "builtin">) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const packDirectory = path.join(directory, entry.name)
          const input = await fs
            .readFile(path.join(packDirectory, "capability.json"), "utf8")
            .then(JSON.parse)
            .catch((error) => {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
              throw error
            })
          if (input === undefined) return undefined
          return Effect.runPromise(CapabilityManifest.decode(input)).then((manifest) =>
            loadPack(manifest, packDirectory, source),
          )
        }),
    )
  ).filter((pack): pack is Pack => pack !== undefined)
}

async function loadPack(
  manifest: CapabilityManifest.Manifest,
  directory: string,
  source: Source,
  embeddedSkills?: Readonly<Record<string, string>>,
): Promise<Pack> {
  if (embeddedSkills) return loadEmbeddedPack(manifest, directory, embeddedSkills)
  const absoluteDirectory = await fs.realpath(directory)
  const skills = await Promise.all(
    manifest.skills.map(async (skill) => {
      const location = await fs.realpath(path.resolve(absoluteDirectory, skill.path))
      if (!contains(absoluteDirectory, location))
        throw new Error(`Skill path escapes capability manifest: ${skill.path}`)
      return freeze({ ...skill, location: AbsolutePath.make(location), content: await fs.readFile(location, "utf8") })
    }),
  )
  return freeze({ ...manifest, source, directory: AbsolutePath.make(absoluteDirectory), skills })
}

function loadEmbeddedPack(
  manifest: CapabilityManifest.Manifest,
  directory: string,
  embeddedSkills: Readonly<Record<string, string>>,
): Pack {
  const absoluteDirectory = path.resolve(directory)
  const skills = manifest.skills.map((skill) => {
    const content = embeddedSkills[skill.path]
    if (content === undefined) throw new Error(`Embedded skill content is missing: ${manifest.id}/${skill.path}`)
    const location = path.resolve(absoluteDirectory, skill.path)
    if (!contains(absoluteDirectory, location)) throw new Error(`Skill path escapes capability manifest: ${skill.path}`)
    return freeze({ ...skill, location: AbsolutePath.make(location), content })
  })
  return freeze({ ...manifest, source: "builtin", directory: AbsolutePath.make(absoluteDirectory), skills })
}

function score(pack: Pack, query: string) {
  const terms = query.toLowerCase().match(/[a-z0-9]+/g) ?? []
  if (terms.length === 0) return 0
  const fields = [
    [pack.id, 100],
    [pack.description, 80],
    ...Object.entries(pack.profiles).flatMap(
      ([id, profile]) =>
        [
          [id, 60],
          [profile.description, 50],
        ] as const,
    ),
    ...pack.runtimes.flatMap((runtime) => [
      [runtime.id, 55],
      [(runtime.command ?? []).join(" "), 30],
      ...(runtime.tools ?? []).map((tool) => [tool, 45] as const),
    ]),
    ...(pack.dependencies?.flatMap(
      (dependency) =>
        [
          [dependency.id, 50],
          [dependency.check.join(" "), 30],
        ] as const,
    ) ?? []),
    ...pack.skills.flatMap(
      (skill) =>
        [
          [skill.name, 45],
          [skill.description, 40],
        ] as const,
    ),
    ...(pack.permissions?.servers
      ? Object.entries(pack.permissions.servers).flatMap(
          ([id, server]) =>
            [
              [id, 35],
              [JSON.stringify(server), 20],
            ] as const,
        )
      : []),
  ] as ReadonlyArray<readonly [string, number]>
  return terms.reduce(
    (total, term) => total + Math.max(0, ...fields.map(([value, weight]) => fieldScore(value, term, weight))),
    0,
  )
}

function fieldScore(value: string, term: string, weight: number) {
  const input = value.toLowerCase()
  if (input.includes(term)) return weight + term.length
  const distance = Math.min(...(input.match(/[a-z0-9]+/g) ?? []).map((token) => levenshtein(term, token)))
  if (distance <= Math.max(1, Math.floor(term.length / 3))) return weight + term.length - distance
  return 0
}

function levenshtein(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (const [row, leftCharacter] of Array.from(left).entries()) {
    const current = [row + 1]
    for (const [column, rightCharacter] of Array.from(right).entries()) {
      current.push(
        Math.min(
          current[column]! + 1,
          previous[column + 1]! + 1,
          previous[column]! + Number(leftCharacter !== rightCharacter),
        ),
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length]!
}

function contains(directory: string, target: string) {
  const relative = path.relative(directory, target)
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}
