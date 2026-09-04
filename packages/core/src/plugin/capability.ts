/// <reference path="../markdown.d.ts" />

export * as CapabilityPlugin from "./capability"

import path from "path"
import { Effect } from "effect"
import { CapabilityCatalog } from "../capability/catalog"
import { CapabilityManifest } from "../capability/manifest"
import { define } from "./internal"
import browserManifest from "./capability/browser/capability.json" with { type: "json" }
import browserTestingContent from "./capability/browser/browser-testing.md" with { type: "text" }
import researchManifest from "./capability/research/capability.json" with { type: "json" }
import researchContent from "./capability/research/research.md" with { type: "text" }

export const BrowserTestingContent = browserTestingContent
export const ResearchContent = researchContent

const entries = [
  { input: browserManifest, directory: path.join(import.meta.dir, "capability", "browser") },
  { input: researchManifest, directory: path.join(import.meta.dir, "capability", "research") },
]

export const Plugin = define({
  id: "capability",
  effect: Effect.fn("CapabilityPlugin.load")(function* () {
    const catalog = yield* CapabilityCatalog.Service
    yield* Effect.forEach(
      entries,
      (entry) =>
        CapabilityManifest.decode(entry.input).pipe(
          Effect.orDie,
          Effect.flatMap((manifest) => catalog.register({ manifest, directory: entry.directory })),
        ),
      { discard: true },
    )
  }),
})
