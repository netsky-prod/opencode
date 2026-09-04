/// <reference path="../markdown.d.ts" />

export * as CapabilityPlugin from "./capability"

import path from "path"
import { Effect } from "effect"
import { CapabilityCatalog } from "../capability/catalog"
import { CapabilityManifest } from "../capability/manifest"
import { define } from "./internal"
import browserManifest from "./capability/browser/capability.json" with { type: "json" }
import browserTestingContent from "./capability/browser/browser-testing.md" with { type: "text" }
import deployManifest from "./capability/deploy/capability.json" with { type: "json" }
import deployContent from "./capability/deploy/deploy.md" with { type: "text" }
import documentsManifest from "./capability/documents/capability.json" with { type: "json" }
import documentsContent from "./capability/documents/documents.md" with { type: "text" }
import githubManifest from "./capability/github/capability.json" with { type: "json" }
import githubContent from "./capability/github/github.md" with { type: "text" }
import mobileManifest from "./capability/mobile/capability.json" with { type: "json" }
import mobileContent from "./capability/mobile/mobile.md" with { type: "text" }
import researchManifest from "./capability/research/capability.json" with { type: "json" }
import researchContent from "./capability/research/research.md" with { type: "text" }
import securityManifest from "./capability/security/capability.json" with { type: "json" }
import securityContent from "./capability/security/security.md" with { type: "text" }

export const BrowserTestingContent = browserTestingContent
export const DeployContent = deployContent
export const DocumentsContent = documentsContent
export const GitHubContent = githubContent
export const MobileContent = mobileContent
export const ResearchContent = researchContent
export const SecurityContent = securityContent

const entries: ReadonlyArray<{
  readonly input: unknown
  readonly directory: string
  readonly skills: Readonly<Record<string, string>>
}> = [
  {
    input: browserManifest,
    directory: path.join("/builtin", "capabilities", "browser"),
    skills: { "browser-testing.md": browserTestingContent },
  },
  {
    input: deployManifest,
    directory: path.join("/builtin", "capabilities", "deploy"),
    skills: { "deploy.md": deployContent },
  },
  {
    input: documentsManifest,
    directory: path.join("/builtin", "capabilities", "documents"),
    skills: { "documents.md": documentsContent },
  },
  {
    input: githubManifest,
    directory: path.join("/builtin", "capabilities", "github"),
    skills: { "github.md": githubContent },
  },
  {
    input: mobileManifest,
    directory: path.join("/builtin", "capabilities", "mobile"),
    skills: { "mobile.md": mobileContent },
  },
  {
    input: researchManifest,
    directory: path.join("/builtin", "capabilities", "research"),
    skills: { "research.md": researchContent },
  },
  {
    input: securityManifest,
    directory: path.join("/builtin", "capabilities", "security"),
    skills: { "security.md": securityContent },
  },
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
          Effect.flatMap((manifest) =>
            catalog.register({ manifest, directory: entry.directory, skills: entry.skills }),
          ),
        ),
      { discard: true },
    )
  }),
})
