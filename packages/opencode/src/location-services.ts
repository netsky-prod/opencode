import { CapabilityRuntime as CoreCapabilityRuntime } from "@opencode-ai/core/capability/runtime"
import { Node } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  buildLocationServiceMap,
  locationServices as coreLocationServices,
  LocationServiceMap,
} from "@opencode-ai/core/location-services"
import { adapterNode } from "./capability/runtime"
import { InstanceStore } from "./project/instance-store"
import { InstanceBootstrap } from "./project/bootstrap"

const replacements: LayerNode.Replacements = [
  [CoreCapabilityRuntime.node, adapterNode],
  [InstanceStore.bootstrapNode, InstanceBootstrap.node],
]

export const locationServices = LayerNode.hoist(coreLocationServices, Node.tags.values.global, replacements)
export const locationServiceMapLayer = buildLocationServiceMap(replacements)
export const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export { LocationServiceMap }
