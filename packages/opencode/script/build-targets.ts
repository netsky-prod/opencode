import { commandName } from "../src/distribution"

export type BuildTarget = {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}

export const allBuildTargets: BuildTarget[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

export function selectBuildTargets(input: {
  releaseTargets: boolean
  single: boolean
  baseline: boolean
  platform: string
  arch: string
}) {
  if (input.releaseTargets) {
    return allBuildTargets.filter(
      (item) => (item.os === "darwin" || item.os === "linux") && item.avx2 !== false && item.abi === undefined,
    )
  }
  if (!input.single) return allBuildTargets
  return allBuildTargets.filter((item) => {
    if (item.os !== input.platform || item.arch !== input.arch) return false
    if (item.avx2 === false) return input.baseline
    if (item.abi !== undefined) return false
    return true
  })
}

export function buildTargetName(item: BuildTarget) {
  return [
    commandName,
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi,
  ]
    .filter(Boolean)
    .join("-")
}
