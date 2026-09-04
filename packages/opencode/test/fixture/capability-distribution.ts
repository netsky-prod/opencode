import path from "path"
import { Effect } from "effect"
import { CapabilityCatalog } from "@opencode-ai/core/capability/catalog"
import { CapabilityPlugin } from "@opencode-ai/core/plugin/capability"
import { host } from "../../../core/test/plugin/host"

const packs = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const catalog = yield* CapabilityCatalog.make({
        projectDirectory: process.cwd(),
        globalDirectory: path.join(process.cwd(), "config"),
      })
      yield* CapabilityPlugin.Plugin.effect(host()).pipe(Effect.provideService(CapabilityCatalog.Service, catalog))
      return yield* catalog.list()
    }),
  ),
)
console.log(JSON.stringify(packs))
