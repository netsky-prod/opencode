import pkg from "../package.json"
import path from "path"

export const productName = "Netsky Code"
export const commandName = "netsky"

export function compatibilityPluginVersion(input: { local: boolean }) {
  if (input.local) return undefined
  return pkg.version
}

export function installationMethod(executable: string) {
  if (executable.endsWith(path.join(".netsky", "bin", commandName))) return "curl" as const
  if (executable.endsWith(path.join(".local", "bin", commandName))) return "curl" as const
  return "unknown" as const
}
