import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import z from "zod"

test("native payload retains every manifest and skill without the source checkout", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "capability-distribution-"))
  const entry = path.join(import.meta.dir, "../fixture/capability-distribution.ts")
  const binary = path.join(directory, "capability-probe")
  try {
    const build = Bun.spawn([process.execPath, "build", "--compile", entry, "--outfile", binary], {
      cwd: path.join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, errors, code] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ])
    expect(code, `${output}\n${errors}`).toBe(0)
    const run = async (command: string[]) => {
      const child = Bun.spawn(command, { cwd: directory, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exit, stderr).toBe(0)
      return z
        .array(
          z
            .object({
              id: z.string(),
              source: z.literal("builtin"),
              profiles: z.record(z.string(), z.unknown()),
              skills: z.array(z.object({ name: z.string(), content: z.string().min(100) }).passthrough()),
            })
            .passthrough(),
        )
        .parse(JSON.parse(stdout))
    }
    const compiled = await run([binary])
    expect(compiled).toEqual(await run([process.execPath, entry]))
    expect(compiled.map((pack) => pack.id)).toEqual([
      "browser",
      "deploy",
      "documents",
      "github",
      "mobile",
      "research",
      "security",
    ])
    for (const pack of compiled) {
      expect(pack.skills.length).toBeGreaterThan(0)
      expect(Object.keys(pack.profiles).length).toBeGreaterThan(0)
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 60_000)
