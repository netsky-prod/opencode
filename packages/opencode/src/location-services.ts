import { CapabilityRuntime as CoreCapabilityRuntime } from "@opencode-ai/core/capability/runtime"
import { Node } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  buildLocationServiceMap,
  locationServices as coreLocationServices,
  LocationServiceMap,
} from "@opencode-ai/core/location-services"
import { adapterNode } from "./capability/runtime"

const replacements: LayerNode.Replacements = [[CoreCapabilityRuntime.node, adapterNode]]

export const locationServices = LayerNode.hoist(coreLocationServices, Node.tags.values.global, replacements)
export const locationServiceMapLayer = buildLocationServiceMap(replacements)
export const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export { LocationServiceMap }
